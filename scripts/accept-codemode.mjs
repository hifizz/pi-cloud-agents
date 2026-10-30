// Local UI-acceptance server for codemode (issue #9). REAL API + REAL built web UI; the only fake is the
// model — fauxProvider is scripted, so no API key or Sprite is needed. Tools run in a real NodeExecutionEnv
// on a temp dir (CodingTools' real bash/read/edit on this host).
//
//   node scripts/accept-codemode.mjs           # then open http://127.0.0.1:8090
//
// Scripted demo (two inputs):
//   input 1 -> codemode script: safe bash + read, then `rm -rf` inside the script -> parks for approval
//              ("in script" badge in the approval bar). Approve -> script finishes -> nested list + output.
//   input 2 -> codemode script with a tiny output budget -> details.fullOutputPath (spill file row).
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openHarness } from "../src/harness.mjs";
import { BotRegistry } from "../src/bots.mjs";
import { createApi } from "../src/api.mjs";
import { Preamble } from "../src/ext/preamble.mjs";
import { createApproval } from "../src/ext/approval.mjs";
import { register as registerApprovals } from "../src/routes/approvals.mjs";
import { createCodemode } from "../src/ext/codemode.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 8090);

// The workspace dir the faux bot works in (read/bash land here).
const cwd = mkdtempSync(join(tmpdir(), "cm-accept-"));
writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "cm-accept-demo", version: "1.0.0" }, null, 2));
writeFileSync(join(cwd, "README.txt"), "codemode acceptance fixture\n");
mkdirSync(join(cwd, "victim"), { recursive: true });
writeFileSync(join(cwd, "victim", "delete-me.txt"), "to be removed\n");

const script1 = [
  `const files = await tools.bash({ command: "ls -1" });`,
  `const pkg = await tools.read({ path: "package.json" });`,
  `await tools.bash({ command: "rm -rf victim" });`,
  `text("package=" + pkg.name);`,
  `return "cleanup done";`,
].join("\n");

const script2 = [
  `// @options: {"max_output_tokens": 40}`,
  `for (let i = 0; i < 40; i++) text("line " + i + " — repeated output to exceed the token budget, forcing a spill file");`,
  `return "spilled";`,
].join("\n");

const call = (name, args, id) => fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
const responses = [
  call("codemode", { code: script1 }, "cm1"),
  fauxAssistantMessage([fauxText("First script finished.")]),
  call("codemode", { code: script2 }, "cm2"),
  fauxAssistantMessage([fauxText("Second script finished.")]),
];

const f = fauxProvider();
const models = createModels();
models.setProvider(f.provider);
f.setResponses(responses);

const { harness } = await openHarness({
  storage: new MemoryStorage(),
  models,
  extensions: [Preamble, CodingTools, createCodemode(), createApproval()],
  env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? cwd }),
});
const bots = new BotRegistry(harness, { path: null });
const bot = await bots.createBot({ name: "cm", model: { provider: "faux", modelId: "faux-1" }, cwd });

// Minimal workspace shape so the UI shows the session (production workspaces come from the control DB).
const wsView = {
  id: "ws-accept",
  name: "codemode-accept",
  repo: "hifizz/pi-cloud-agents",
  baseBranch: "main",
  branch: "devin/issue-9",
  status: "ready",
  task: "codemode UI acceptance",
  steps: ["runtime", "init", "code", "deps", "agent"].map((step) => ({ step, state: "done" })),
  botId: bot.id,
  binding: { provider: "local", runtimeId: "accept-env-1" },
  createdAt: Date.now(),
  updatedAt: Date.now(),
};
const stubWorkspaces = (app) => {
  // No auth in this harness: report a logged-in local user so the UI skips its login screen.
  app.get("/api/auth/me", () => ({ email: "accept@local" }));
  app.post("/api/auth/logout", () => ({ ok: true }));
  app.get("/api/workspaces", () => [wsView]);
  app.get("/api/workspaces/:id", () => wsView);
  app.get("/api/routines", () => []);
};

const api = createApi({ harness, bots, staticDir: join(ROOT, "web", "dist"), routes: [registerApprovals, stubWorkspaces] });
const { port } = await api.listen(PORT);
console.log(`accept server on http://127.0.0.1:${port}  (bot=${bot.id}, cwd=${cwd})`);
console.log("input 1: script -> bash+read ok, rm -rf parks for approval; approve it in the bar");
console.log("input 2: script output spills -> details.fullOutputPath shown in the tool card");
