// M1-14 acceptance helper (orchestrator only). Talks to a locally running server (http://127.0.0.1:8090) and, for evidence,
// runs commands in a pca-* Sprite through the same bash primitive the server uses. Never prints env values.
//   node scratch/m1-accept.mjs create <requestId> <repo> "<task>" [modelId]   -> workspace json (id, branch)
//   node scratch/m1-accept.mjs wait <workspaceId> [timeoutSec]                -> waits for ready/failed
//   node scratch/m1-accept.mjs say <botId> "<text>" [requestId]
//   node scratch/m1-accept.mjs idle <botId> [timeoutSec]                      -> waits until the bot is not busy
//   node scratch/m1-accept.mjs transcript <botId> [n]
//   node scratch/m1-accept.mjs ws <workspaceId>                               -> status, steps, binding
//   node scratch/m1-accept.mjs sh <runtimeId> "<command>"                     -> runs in that Sprite (managed ones only)
//   node scratch/m1-accept.mjs sprites                                        -> lists pca-* Sprites with labels
import { SpritesClient } from "@fly/sprites";

process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
const BASE = process.env.ACCEPT_BASE ?? "http://127.0.0.1:8090";
const [cmd, ...args] = process.argv.slice(2);

async function api(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${typeof json === "string" ? json : JSON.stringify(json)}`);
  return json;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function textOfEntry(e) {
  const out = [];
  for (const m of e.model ?? []) {
    const c = m.content;
    if (typeof c === "string") out.push(`${m.role}: ${c}`);
    else if (Array.isArray(c)) {
      for (const p of c) {
        if (p.type === "text" && p.text?.trim()) out.push(`${m.role}: ${p.text}`);
        else if (p.type === "toolCall") out.push(`CALL ${JSON.stringify(p.arguments).slice(0, 400)}`);
      }
    }
  }
  return out.join("\n");
}

async function main() {
  if (cmd === "create") {
    const [requestId, repo, task, modelId = "swe-2"] = args;
    const ws = await api("POST", "/api/workspaces", { requestId, repo, baseBranch: "main", task, modelId });
    console.log(JSON.stringify({ id: ws.id, branch: ws.branch, status: ws.status }));
  } else if (cmd === "wait") {
    const [id, t = "300"] = args;
    const end = Date.now() + Number(t) * 1000;
    let last = "";
    for (;;) {
      const w = await api("GET", `/api/workspaces/${id}`);
      const line = `${w.status} ${w.steps.map((s) => `${s.step}:${s.state}`).join(" ")} ${w.binding?.runtimeId ?? "-"} ${w.error ?? ""}`;
      if (line !== last) console.log(line);
      last = line;
      if (w.status === "ready" || w.status === "failed") return console.log(JSON.stringify({ id, botId: w.botId, runtimeId: w.binding?.runtimeId, branch: w.branch }));
      if (Date.now() > end) throw new Error("timeout waiting for workspace");
      await sleep(3000);
    }
  } else if (cmd === "say") {
    const [botId, text, requestId = `say-${Date.now()}`] = args;
    console.log(JSON.stringify(await api("POST", `/api/bots/${botId}/input`, { text, requestId })));
  } else if (cmd === "idle") {
    const [botId, t = "300"] = args;
    const end = Date.now() + Number(t) * 1000;
    for (;;) {
      const list = await api("GET", "/api/bots");
      const b = list.find((x) => x.id === botId);
      if (b && !b.busy && !b.queued) return console.log("idle");
      if (Date.now() > end) throw new Error("timeout waiting for bot to become idle");
      await sleep(2000);
    }
  } else if (cmd === "transcript") {
    const [botId, n = "60"] = args;
    const entries = await api("GET", `/api/bots/${botId}/entries?limit=${n}`);
    for (const e of [...entries].reverse()) {
      const t = textOfEntry(e);
      if (t) console.log(t.slice(0, 1500));
      for (const m of e.model ?? []) if (m.role === "toolResult") console.log("RESULT", JSON.stringify(m.content).slice(0, 1500), m.isError ? "(isError)" : "");
    }
  } else if (cmd === "ws") {
    const w = await api("GET", `/api/workspaces/${args[0]}`);
    console.log(JSON.stringify({ status: w.status, steps: w.steps.map((s) => `${s.step}:${s.state}`), binding: w.binding, botId: w.botId, branch: w.branch }, null, 1));
  } else if (cmd === "sprites" || cmd === "sh") {
    const client = new SpritesClient(process.env.SPRITES_TOKEN);
    if (cmd === "sprites") {
      const r = await client.listSprites({ prefix: "pca-" });
      for (const s of r.sprites) console.log(s.name, JSON.stringify(s.labels));
      return;
    }
    const [runtimeId, command] = args;
    const s = await client.getSprite(runtimeId);
    if (!runtimeId.startsWith("pca-") || !(s.labels ?? []).includes("app:pi-cloud-agents")) throw new Error("refusing: not a managed Sprite");
    const { createSpritesBash } = await import("../src/sandbox/sprites.mjs");
    const bash = createSpritesBash({ client, name: runtimeId, secrets: [process.env.SPRITES_TOKEN] });
    const r = await bash(command, { timeoutMs: 120_000 });
    process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exitCode = r.exitCode ?? 0;
  } else {
    throw new Error("unknown command");
  }
}
main().catch((e) => {
  console.error(String(e.message ?? e).replace(/\s+/g, " ").slice(0, 600));
  process.exit(1);
});
