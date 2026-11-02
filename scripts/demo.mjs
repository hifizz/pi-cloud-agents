// Demo manifest: the single source of truth for what runs where.
// Lives on the demo branch INSIDE the pinned worktree (/Users/zilin/side/pca-wia-demo), so switching
// branches in the main checkout never changes demo behavior. Run it from anywhere by absolute path.
//
//   node scripts/demo.mjs              # status of every known port
//   node scripts/demo.mjs restart wia  # restart the wia demo (backend 8092 + vite 5183) from THIS worktree
//
// Rules encoded here:
//   - Restart commands are never reconstructed from memory; this table is the only place they live.
//   - 8090 (the original service, live scheduled loops) is listed for status only and is NEVER restarted here.
//   - TARSBOT_ENV_KEY is generated ONCE into the demo data dir and reused (env secrets stay readable).
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const WT = resolve(import.meta.dirname, "..");
const DATA = "/tmp/pca-wia-demo-data";

const demos = {
  wia: {
    desc: "WIA demo: composer + issue-loop allowlist (branch demo/wia, this worktree)",
    backend: { port: 8092, launcher: `${WT}/scripts/demo-launch-wia.mjs` },
    vite: { port: 5183, config: "vite.8092.config.ts" },
    dataDir: DATA,
    env: {
      TARSBOT_DATA_DIR: DATA,
      TARSBOT_ISSUE_LOOP_REPOS: "hifizz/tars-sandbox-playground,hifizz/pi-cloud-agents",
      TARSBOT_ALLOWED_EMAILS: "demo@localhost,env-demo@localhost",
    },
  },
};

// Status-only entries: never restarted by this script.
const foreign = [
  { name: "original", port: 8090, desc: "原服务（有定时 loops 在跑）— 只看状态，绝不在这里重启" },
  { name: "env-demo", port: 8091, desc: "env-demo 验收实例 — 只看状态" },
];

const sh = (cmd) => execSync(cmd).toString().trim();
const pidOf = (port) => {
  try {
    const out = sh(`lsof -tiTCP:${port} -sTCP:LISTEN`);
    return out ? Number(out.split("\n")[0]) : null;
  } catch {
    return null;
  }
};

function envKey() {
  mkdirSync(DATA, { recursive: true });
  const f = `${DATA}/env.key`;
  if (existsSync(f)) return readFileSync(f, "utf8").trim();
  const key = `wia-demo-${[...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  writeFileSync(f, key);
  return key;
}

function stop(port) {
  const pid = pidOf(port);
  if (!pid) return;
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && pidOf(port)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  if (pidOf(port)) process.kill(pid, "SIGKILL");
  console.log(`stopped :${port} (pid ${pid})`);
}

function startDetached(args, env, { cwd = WT, log } = {}) {
  const out = log ? openSync(log, "a") : "ignore";
  const child = spawn(args[0], args.slice(1), { cwd, env: { ...process.env, ...env }, detached: true, stdio: ["ignore", out, out] });
  child.unref();
  console.log(`started: ${args.join(" ")} (pid ${child.pid})${log ? ` log ${log}` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function status() {
  console.log(`worktree: ${WT}`);
  console.log(`branch:   ${sh(`git -C ${WT} branch --show-current`)} @ ${sh(`git -C ${WT} rev-parse --short HEAD`)}`);
  for (const [name, d] of Object.entries(demos)) {
    const b = pidOf(d.backend.port);
    const v = d.vite ? pidOf(d.vite.port) : null;
    console.log(`${name.padEnd(8)} :${d.backend.port} ${b ? `UP(${b})` : "down"}  vite :${d.vite?.port} ${d.vite ? (v ? `UP(${v})` : "down") : "-"}  data ${d.dataDir}  ${d.desc}`);
  }
  for (const f of foreign) {
    const p = pidOf(f.port);
    console.log(`${f.name.padEnd(8)} :${f.port} ${p ? `UP(${p})` : "down"}  ${f.desc}`);
  }
}

const [, , cmd, name] = process.argv;
if (cmd === "restart" && demos[name]) {
  const d = demos[name];
  stop(d.backend.port);
  if (d.vite) stop(d.vite.port);
  const env = { ...d.env, TARSBOT_ENV_KEY: envKey() };
  startDetached(["node", d.backend.launcher], env, { log: "/tmp/pca-wia-demo.log" });
  if (d.vite) startDetached(["npx", "vite", "--config", d.vite.config], env, { cwd: `${WT}/web`, log: "/tmp/pca-wia-vite.log" });
  await sleep(2500);
}
status();
