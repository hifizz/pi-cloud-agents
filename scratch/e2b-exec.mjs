// Run a command in the E2B sandbox through the production primitive (src/sandbox/e2b.mjs) or read its status.
// Always start it as:  node --env-file=.env scratch/e2b-exec.mjs ...   (the shell never reads or prints .env).
//
//   e2b-exec.mjs exec [--timeout-ms N] <command>   stdout/stderr of the command; exit code = command's (124 on timeout, 125 on SDK error)
//   e2b-exec.mjs status                            prints state (running|paused), endAt and lifecycle of the sandbox
//
// Safety: refuses to run unless TARSBOT_E2B_NAME is exactly "pi-cloud-agents". Everything printed is scrubbed of secrets.
import { e2bBash } from "../src/sandbox/e2b.mjs";

const NAME = "pi-cloud-agents";
if (process.env.TARSBOT_E2B_NAME !== NAME) {
  console.error(`refusing to run: TARSBOT_E2B_NAME must be exactly "${NAME}"`);
  process.exit(2);
}
const SECRETS = [process.env.E2B_API_KEY, process.env.GITHUB_TOKEN].filter((s) => typeof s === "string" && s.length >= 8);
const scrub = (s) => {
  let t = String(s ?? "");
  for (const v of SECRETS) t = t.split(v).join("<redacted>");
  return t.replace(/(github_pat_|ghp_|gho_|ghs_|ghu_|e2b_)[A-Za-z0-9_]{10,}/g, "<redacted>");
};

const [mode, ...rest] = process.argv.slice(2);

if (mode === "status") {
  try {
    const { Sandbox } = await import("e2b");
    const p = Sandbox.list({ apiKey: process.env.E2B_API_KEY, query: { metadata: { app: "pi-cloud-agents", name: NAME } } });
    const items = [];
    do items.push(...(await p.nextItems()));
    while (p.hasNext);
    if (items.length === 0) console.log("missing");
    for (const i of items) console.log(scrub(JSON.stringify({ state: i.state, startedAt: i.startedAt, endAt: i.endAt, lifecycle: i.lifecycle, cpuCount: i.cpuCount, memoryMB: i.memoryMB })));
  } catch (e) {
    console.error(scrub(`status error: ${e?.message ?? e}`));
    process.exit(125);
  }
} else if (mode === "exec") {
  let timeoutMs;
  if (rest[0] === "--timeout-ms") {
    timeoutMs = Number(rest[1]);
    rest.splice(0, 2);
  }
  const command = rest.join(" ");
  if (!command) {
    console.error("usage: e2b-exec.mjs exec [--timeout-ms N] <command>");
    process.exit(2);
  }
  try {
    const r = await e2bBash(command, { timeoutMs });
    if (r.stdout) process.stdout.write(scrub(r.stdout));
    if (r.stderr) process.stderr.write(scrub(r.stderr));
    process.exit(r.timedOut ? 124 : r.exitCode);
  } catch (e) {
    console.error(scrub(`exec error: ${e?.message ?? e}`));
    process.exit(125);
  }
} else {
  console.error("usage: e2b-exec.mjs exec [--timeout-ms N] <command> | status");
  process.exit(2);
}
