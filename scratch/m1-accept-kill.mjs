// Scenario 5 driver (M1-14): long command + kill -9 of the server, repeated. Orchestrator only.
//   node scratch/m1-accept-kill.mjs <round> <botId> <runtimeId> <workspaceId>
// Needs the server started by scratch/m1-accept-server.sh (PID in /tmp/pca-accept-pid, data dir in /tmp/pca-accept-dir).
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, openSync } from "node:fs";

const [round, botId, runtimeId] = process.argv.slice(2);
const REPO = new URL("..", import.meta.url).pathname;
const acc = (...a) => execFileSync("node", ["scratch/m1-accept.mjs", ...a], { cwd: REPO, encoding: "utf8", timeout: 200_000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = readFileSync("/tmp/pca-accept-dir", "utf8").trim();
const total = Number(process.env.LINES ?? 18); // 18 lines x 5 s = 90 s

const counter = `/tmp/pca-count-${round}`;
const log = `/tmp/pca-log-${round}`;
const command = `rm -f ${counter}; for i in $(seq 1 ${total}); do echo tick-${round}-$i; echo run >> ${counter}; sleep 5; done; echo finished-${round}`;
const prompt = `Run exactly this one bash command, once, and wait for it to finish (do not re-run it, do not wrap it): ${command}\nThen reply with the last line of its output.`;

console.log(acc("say", botId, prompt, `kill-${round}`).trim());
await sleep(25_000); // about 5 ticks
const pid = Number(readFileSync("/tmp/pca-accept-pid", "utf8"));
console.log("progress before kill:", acc("sh", runtimeId, `wc -l < ${counter}`).trim(), "lines");
process.kill(pid, "SIGKILL");
console.log("server killed (SIGKILL)", pid);
await sleep(3000);
const out = openSync(`${REPO}logs/accept-server.log`, "a");
const child = spawn("node", ["src/server.mjs"], {
  cwd: REPO,
  env: { ...process.env, TARSBOT_AUTH_DISABLED: "1", TARSBOT_DATA_DIR: dir },
  detached: true,
  stdio: ["ignore", out, out],
});
child.unref();
await sleep(1500);
execFileSync("sh", ["-c", `echo ${child.pid} > /tmp/pca-accept-pid`]);
console.log("server restarted", child.pid);
for (let i = 0; i < 20; i++) {
  try {
    const r = await fetch("http://127.0.0.1:8090/api/health");
    if (r.ok) break;
  } catch {}
  await sleep(500);
}
console.log(acc("idle", botId, "300").trim());
console.log("counter lines at the end:", acc("sh", runtimeId, `wc -l < ${counter}`).trim(), `(expected ${total})`);
console.log("runner state:", acc("sh", runtimeId, `ls ~/.pca/runs | wc -l`).trim(), "run dirs");
console.log("--- transcript tail ---");
console.log(acc("transcript", botId, "12"));
