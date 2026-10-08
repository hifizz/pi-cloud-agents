// Acceptance helper: send a prompt to a Bot via the API and stream condensed events until the run ends.
// Usage: node scripts/ask.mjs <bot> "<prompt>" [--steer] [--timeout 300]
import WebSocket from "ws";

const args = process.argv.slice(2);
const [bot, prompt] = args;
const base = process.env.TARSBOT_URL ?? "http://127.0.0.1:8080";
const timeoutS = Number(args[args.indexOf("--timeout") + 1]) || 300;
const whenBusy = args.includes("--steer") ? "steer" : undefined;

const ws = new WebSocket(`${base.replace("http", "ws")}/api/bots/${bot}/stream`);
const tools = [];
let answer = "";
let started = false;
const done = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timeout")), timeoutS * 1000);
  ws.on("message", (buf) => {
    const frame = JSON.parse(buf);
    if (frame.type !== "events") return;
    for (const e of frame.events) {
      if (e.type === "run_start") started = true;
      if (e.type === "tool_execution_start") {
        tools.push(e.toolName);
        console.log(`→ ${e.toolName} ${JSON.stringify(e.args).slice(0, 160)}`);
      }
      if (e.type === "message_update") for (const c of e.changes) if (c.type === "text_delta") answer += c.delta;
      if (e.type === "message_end") {
        const m = e.entry?.model?.[0];
        if (m?.role === "assistant" && Array.isArray(m.content)) {
          const t = m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
          if (t) answer = t;
        }
      }
      if (e.type === "task_failed") console.log(`! ${e.kind}: ${e.message}`);
      if (e.type === "run_end" && started) {
        clearTimeout(timer);
        resolve();
      }
    }
  });
});
await new Promise((r) => ws.once("open", r));
const res = await fetch(`${base}/api/bots/${bot}/input`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text: prompt, ...(whenBusy ? { whenBusy } : {}) }),
});
console.log("submitted", res.status, await res.text());
try {
  await done;
} finally {
  ws.close();
}
console.log("tools:", tools.join(", "));
console.log("answer:", answer.trim().split("\n").filter(Boolean).slice(-6).join("\n"));
