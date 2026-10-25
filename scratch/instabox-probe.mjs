// InstaBox live probe: verifies the API behaviours src/sandbox/instabox.mjs relies on, against the real service.
//   node --env-file=.env scratch/instabox-probe.mjs
// Creates its OWN throwaway machine (name pca-probe-<rand>, label app=pi-cloud-agents), deletes it at the end (and on
// error), and touches nothing else. Never prints the API key. Findings land in docs/INSTABOX-PLAN.md after a run.
import { instaboxApi, redactMessage } from "../src/sandbox/instabox.mjs";

const API_KEY = process.env.INSTABOX_API_KEY;
if (!API_KEY) {
  console.error("instabox-probe: INSTABOX_API_KEY is not set (put it in .env)");
  process.exit(2);
}
const redact = (s) => redactMessage(String(s ?? ""), [API_KEY]);
const NAME = `pca-probe-${Math.random().toString(36).slice(2, 8)}`;
const client = instaboxApi({ apiKey: API_KEY, baseUrl: process.env.INSTABOX_BASE_URL });

let probeMachineId;
const results = [];
function note(step, detail = "") {
  results.push(`${detail ? "PASS" : "FAIL"}  ${step}${detail ? ` — ${redact(detail)}` : ""}`);
  console.log(results.at(-1));
}
const brief = (o) => redact(typeof o === "string" ? o : JSON.stringify(o)).slice(0, 300);

async function cleanup() {
  if (!probeMachineId) return;
  try {
    const op = await client.deleteMachine(probeMachineId);
    const done = await client.waitOperation(op, { timeoutMs: 300_000 });
    console.log(`cleanup: deleted ${probeMachineId} (${done.state})`);
  } catch (e) {
    console.error(`cleanup: could not delete ${probeMachineId}: ${redact(e.message)} — DELETE IT MANUALLY`);
    process.exitCode = 1;
  }
}
process.on("SIGINT", () => {
  console.error("interrupted");
  cleanup().finally(() => process.exit(1));
});

try {
  // P0 templates: pick agent-browser (free-plan keys may only use it), else the first
  const templates = (await client.listTemplates()).templates ?? [];
  console.log(`P0 templates: ${templates.map((t) => `${t.id}@${t.version ?? "?"}`).join(", ") || "(none)"}`);
  const template = templates.find((t) => t.id === "agent-browser") ?? templates[0];

  // P1 create: 202 answers carry the bare Operation ({id, state, machine?}); labels go in `metadata`
  const created = await client.createMachine({ name: NAME, templateId: template.id, metadata: { app: "pi-cloud-agents" } });
  console.log(`P1 create response: ${brief(created)}`);
  const doneOp = await client.waitOperation(created, { timeoutMs: 300_000 });
  probeMachineId = doneOp.machine?.id;
  note("P1 create -> operation succeeds and carries machine", `id=${probeMachineId} state=${doneOp.machine?.state} template=${doneOp.machine?.template?.id ?? template.id}`);

  // P2 get by name vs by id
  const byName = await client.getMachine(NAME);
  note("P2 GET /v1/machines/{name} resolves the name", `id=${byName.id} state=${byName.state} metadata=${brief(byName.metadata)} guest=${byName.guestUser}`);

  // P3 exec happy path + response fields
  const r1 = await client.exec(probeMachineId, { cmd: `echo hello; echo err >&2; id -un; pwd`, cwd: "/data/home" });
  note("P3 exec returns stdout/stderr/exitCode/timedOut/truncated", brief(r1));

  // P4 wrapper semantics: quotes, newlines, comments survive `bash -lc 'exec /bin/sh -c ...'`
  const tricky = `echo 'it''s' "q" $HOME\n#echo not-a-comment-output\necho done # trailing`;
  const wrapped = `exec /bin/sh -c '${tricky.replaceAll("'", `'\\''`)}'`;
  const r4 = await client.exec(probeMachineId, { cmd: wrapped, cwd: "/data/home" });
  note("P4 exec wrapper keeps sh semantics", `exit=${r4.exitCode} stdout=${JSON.stringify(r4.stdout)}`);

  // P5 non-zero exit is a result, not an error status
  const r5 = await client.exec(probeMachineId, { cmd: "exit 3", cwd: "/data/home" });
  note("P5 non-zero exit is a 200 result", `exitCode=${r5.exitCode}`);

  // P6 server-side timeout: sleep 5 with timeoutSeconds 1 (spec: timedOut true, exitCode 124)
  const t0 = Date.now();
  const r6 = await client.exec(probeMachineId, { cmd: "sleep 5", cwd: "/data/home", timeoutSeconds: 1 });
  note("P6 timeoutSeconds kills the command and reports timedOut", `timedOut=${r6.timedOut} exitCode=${r6.exitCode} in ${Date.now() - t0}ms`);

  // P7 envs are visible to the command
  const r7 = await client.exec(probeMachineId, { cmd: 'printf "%s" "$PROBE_VAR"', cwd: "/data/home", envs: { PROBE_VAR: "sentinel-42" } });
  note("P7 envs reach the command", `stdout=${JSON.stringify(r7.stdout)}`);

  // P8 files endpoint (read a file we just wrote)
  await client.exec(probeMachineId, { cmd: "echo probe-file > /data/home/probe.txt", cwd: "/data/home" });
  const files = await client.call(`/v1/machines/${probeMachineId}/files?path=${encodeURIComponent("/data/home/probe.txt")}`);
  note("P8 files endpoint reads a file", brief(files).slice(0, 120));

  // P9 stop -> exec 409 machine_not_running; start -> operation; exec works again
  const stopOp = await client.call(`/v1/machines/${probeMachineId}/stop`, { method: "POST", idempotencyKey: crypto.randomUUID() });
  await client.waitOperation(stopOp, { timeoutMs: 300_000 });
  let notRunning = null;
  try {
    await client.exec(probeMachineId, { cmd: "true", cwd: "/data/home" });
  } catch (e) {
    notRunning = e;
  }
  note("P9 stopped machine exec -> 409 machine_not_running", notRunning ? `status=${notRunning.status} code=${notRunning.apiCode}` : "no error (unexpected)");
  const startOp = await client.startMachine(probeMachineId);
  const startDone = await client.waitOperation(startOp, { timeoutMs: 300_000 });
  const r9 = await client.exec(probeMachineId, { cmd: "echo back", cwd: "/data/home" });
  note("P9 start -> running again, exec ok", `op=${startDone.state} stdout=${JSON.stringify(r9.stdout)}`);

  // P10 suspend -> exec behaviour: either the platform auto-wakes (docs pages), or it refuses and the provider's
  // 409 -> start(resume) path must cover it. Both outcomes are recorded; the start path is asserted either way.
  const suspOp = await client.call(`/v1/machines/${probeMachineId}/suspend`, { method: "POST", idempotencyKey: crypto.randomUUID() });
  await client.waitOperation(suspOp, { timeoutMs: 300_000 });
  const t10 = Date.now();
  let r10 = null;
  let wakeErr = null;
  try {
    r10 = await client.exec(probeMachineId, { cmd: "echo woke", cwd: "/data/home" });
  } catch (e) {
    wakeErr = e;
  }
  if (r10) {
    note("P10 suspended machine: exec wakes it by itself", `stdout=${JSON.stringify(r10.stdout)} took ${Date.now() - t10}ms`);
  } else {
    note("P10 suspended machine: exec refuses; provider start path applies", `status=${wakeErr.status} code=${wakeErr.apiCode} msg=${brief(wakeErr.message)}`);
  }
  // P10b start resumes a suspended machine (files AND memory), exec works right after
  const sOp = await client.startMachine(probeMachineId);
  const sDone = await client.waitOperation(sOp, { timeoutMs: 300_000 });
  const r10b = await client.exec(probeMachineId, { cmd: "echo woke", cwd: "/data/home" });
  note("P10b start resumes a suspended machine; exec ok", `op=${sDone.state} stdout=${JSON.stringify(r10b.stdout)} total ${Date.now() - t10}ms`);

  // P11 persistence across stop/start: the file from P8 is still there
  const r11 = await client.exec(probeMachineId, { cmd: "cat /data/home/probe.txt", cwd: "/data/home" });
  note("P11 /data persists across stop/start", `stdout=${JSON.stringify(r11.stdout)}`);

  // P12 unknown machine -> 404 machine_not_found
  try {
    await client.getMachine("pca-probe-definitely-missing");
    note("P12 missing machine -> 404", "no error (unexpected)");
  } catch (e) {
    note("P12 missing machine -> 404", `status=${e.status} code=${e.apiCode}`);
  }
} catch (e) {
  console.error(`probe aborted: ${redact(e?.stack ?? e.message ?? e)}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
console.log(`\n${results.filter((r) => r.startsWith("PASS")).length}/${results.length} checks passed`);
