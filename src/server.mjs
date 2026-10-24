// Production entry: control db + providers + harness + workspaces + API + static web UI.
//
// Startup order matters (docs/M1-PLAN.md §3.6). A tool call that was interrupted by a crash re-enters `execute` the
// moment the harness is resumed, and it needs the workspace -> runner resolver by then. So:
//   1. control db (+ namespace / generation)   2. github, providers, checkpoints
//   3. harness opened WITHOUT scheduling        4. Exec resolver, workspace service, rebuild
//   5. workspaces.resumePending()               6. harness.resume()  (last)   7. API
import { existsSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, config } from "./config.mjs";
import { ctx } from "./harness.mjs";
import { BotRegistry } from "./bots.mjs";
import { bootstrap } from "./runtime.mjs";
import { createApi } from "./api.mjs";
import { openControlStore } from "./control/store.mjs";
import { createGithubClient } from "./github.mjs";
import { createSpritesProvider } from "./providers/sprites.mjs";
import { createCheckpointService } from "./checkpoint.mjs";
import { createWorkspaceService } from "./workspaces.mjs";
import { rebuildWorkspace, register as registerRebuildRoute } from "./workspace-rebuild.mjs";
import { createRunnerClient } from "./runner/client.mjs";
import { setExecResolver } from "./ext/exec.mjs";

/** Dynamically import every src/routes/*.mjs (each exports register(app)). */
export async function loadRoutes(dir = join(ROOT, "src", "routes")) {
  if (!existsSync(dir)) return [];
  const out = [];
  // The rebuild route lives next to the rebuild logic (src/workspace-rebuild.mjs), not under src/routes/.
  if (dir === join(ROOT, "src", "routes")) out.push(registerRebuildRoute);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort()) {
    const mod = await import(pathToFileURL(join(dir, file)).href);
    if (typeof mod.register === "function") out.push(mod.register);
    else console.warn(`routes/${file}: no register(app) export, skipped`);
  }
  return out;
}

/** Fail at startup with a clear message when a required secret is missing. Values are never printed. */
export function assertStartupConfig(env = process.env) {
  if (!env.SPRITES_TOKEN) throw new Error("SPRITES_TOKEN is not set: workspaces need Sprites (put it in .env or Fly secrets)");
}

/**
 * Wire everything in the right order. Nothing is listening yet. Dependencies can be replaced for tests:
 * `providers`, `github`, `bots`, `store`, `runnerFor`, `harnessOptions` (storage / models / settings ...).
 * Returns the pieces plus `ctxForApi` (the `app.ctx` additions for route plugins) and `close()`.
 * `hooks.afterHarnessOpen` / `hooks.beforeResume` are test seams that run at those two points.
 */
export async function assemble({
  store: givenStore,
  controlDbPath = config.controlDbPath,
  checkpointDir = config.checkpointDir,
  botsPath,
  github: givenGithub,
  providers: givenProviders,
  runnerFor: givenRunnerFor,
  harnessOptions = {},
  secrets = [],
  serviceOptions = {},
  hooks = {},
} = {}) {
  // 1. control db
  const store = givenStore ?? openControlStore({ path: controlDbPath });
  store.meta.ensure("namespace", () => randomUUID());
  store.meta.ensure("generation", () => 1);

  // 2. github, providers, checkpoints
  const github = givenGithub ?? createGithubClient();
  let providers = givenProviders;
  if (!providers) {
    assertStartupConfig();
    const { SpritesClient } = await import("@fly/sprites");
    providers = {
      sprites: createSpritesProvider({
        client: new SpritesClient(process.env.SPRITES_TOKEN),
        ghToken: process.env.GITHUB_TOKEN || undefined,
        gitEmail: process.env.TARSBOT_GIT_EMAIL || undefined,
        log: process.env.TARSBOT_SPRITES_LOG ? (e) => console.error(`[sprites] ${JSON.stringify(e)}`) : undefined,
      }),
    };
  }
  const redactList = [...secrets, process.env.GITHUB_TOKEN, process.env.SPRITES_TOKEN].filter(Boolean);
  const checkpoints = createCheckpointService({ store, dir: checkpointDir });

  // runner clients: one per runtime
  const runners = new Map();
  const runnerForRuntime = (provider, runtimeId) => {
    let r = runners.get(runtimeId);
    if (!r) {
      r = createRunnerClient({ bash: provider.bash(runtimeId) });
      runners.set(runtimeId, r);
    }
    return r;
  };
  // The workspace service and rebuild only create Sprites through `providers.sprites`.
  const runnerFor = givenRunnerFor ?? ((runtimeId) => runnerForRuntime(providers.sprites, runtimeId));

  // 3. harness, not scheduled yet
  const { harness } = await bootstrap({ ...harnessOptions, store, providers, resume: false });
  await hooks.afterHarnessOpen?.({ harness, store });
  const bots = new BotRegistry(harness, botsPath === undefined ? {} : { path: botsPath });

  // 4. Exec resolver (conversation -> workspace -> current binding -> runner), workspace service, rebuild
  setExecResolver(({ conversationId } = {}) => {
    if (conversationId === undefined || conversationId === null) return undefined;
    const workspace = store.links.workspaceOf(String(conversationId));
    if (!workspace) return undefined;
    const binding = store.bindings.current(workspace.id);
    if (!binding) return undefined;
    const provider = Object.hasOwn(providers, binding.provider) ? providers[binding.provider] : undefined;
    if (!provider) return undefined;
    return { store, runner: givenRunnerFor ? givenRunnerFor(binding.runtimeId) : runnerForRuntime(provider, binding.runtimeId), workspace, binding };
  });

  const workspaces = createWorkspaceService({ store, github, providers, bots, ctx, runnerFor, secrets: redactList, ...serviceOptions });
  const rebuild = (args) =>
    rebuildWorkspace({ svc: workspaces, store, github, providers, cps: checkpoints, runnerFor, secrets: redactList }, args);

  const runtimeBash = async (workspaceId) => {
    const binding = store.bindings.current(workspaceId);
    if (!binding) throw new Error(`workspace ${workspaceId} has no active binding`);
    const provider = Object.hasOwn(providers, binding.provider) ? providers[binding.provider] : undefined;
    if (!provider) throw new Error(`provider ${binding.provider} is not registered`);
    return provider.bash(binding.runtimeId);
  };

  // 5. continue unfinished workspaces, 6. only then let interrupted tool calls re-enter
  await workspaces.resumePending();
  await hooks.beforeResume?.({ harness, store, workspaces, rebuild, checkpoints });
  harness.resume();

  const ctxForApi = { workspaces, github, control: store, checkpoints, rebuild, runtimeBash };

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    try {
      await workspaces.idle();
    } catch {
      // background runs never block shutdown
    }
    await harness.close(ctx);
    if (!givenStore) store.close();
  }
  return { store, harness, bots, github, providers, workspaces, checkpoints, rebuild, runtimeBash, ctxForApi, close };
}

export async function main() {
  assertStartupConfig();
  const parts = await assemble();
  console.log("resume done");
  const api = createApi({
    harness: parts.harness,
    bots: parts.bots,
    staticDir: join(ROOT, "web", "dist"),
    routes: await loadRoutes(),
    extraCtx: parts.ctxForApi,
  });
  const { port } = await api.listen(config.port, config.host);
  console.log(`TARSBot listening on http://${config.host}:${port}`);

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`${signal} received, shutting down`);
    try {
      await api.close();
      await parts.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error("fatal:", e?.stack ?? e);
    process.exit(1);
  });
}
