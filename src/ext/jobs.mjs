// Long commands return early (bdots idea 15): `start_job` launches a command with nohup in the sandbox, writes its
// output to ~/.jobs/<id>.log and returns the job id at once; `job_wait` / `job_status` poll or block until it exits.
// This keeps long builds from holding a tool call open (which also loses output when the sandbox link hiccups).
//
// The job table is a session doc so the UI can list jobs across bots; the log lives in the sandbox filesystem.
import { randomUUID } from "node:crypto";
import { defineDoc, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { runCapture } from "./capture.mjs";

const JOBS_DIR = "~/.jobs";
const MAX_JOBS = 200;
const POLL_MS = 1000;

const q = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;

/** Session document: job id -> {id, command, botConversationId, logPath, startedAt, endedAt?, exitCode?, status}. */
export const JobsDoc = defineDoc({
  kind: "tarsbot.jobs",
  version: 1,
  scope: "session",
  initial: () => ({ jobs: {} }),
  checkpointWhen: () => false,
});

/**
 * @param {{ now?: () => number, jobsDir?: string }} [opts] jobsDir: test hook for an isolated directory
 */
export function createJobs(opts = {}) {
  const now = opts.now ?? Date.now;
  const jobsDir = opts.jobsDir ?? JOBS_DIR;

  const startJob = defineTool({
    name: "start_job",
    description:
      `Start a long-running command (builds, test suites, dev servers) in the background and return its job id at once. ` +
      `Output goes to ${JOBS_DIR}/<id>.log in the sandbox. Use job_wait to wait for it and job_status to peek. ` +
      "Prefer the plain bash tool for anything under a minute. start_job is for slow commands, not for hiding failures.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run in the background" }),
      label: Type.Optional(Type.String({ description: "Short label for the job list" })),
    }),
    replay: "unsafe",
    async execute(args, api, context) {
      const env = api.env;
      if (!env) throw new Error("start_job needs an execution environment");
      const command = String(args.command ?? "").trim();
      if (!command) throw new Error("command is required");
      const id = randomUUID().slice(0, 8);
      const log = `${jobsDir}/${id}.log`;
      const done = `${jobsDir}/${id}.done`;
      // One background bash runs the command and writes its own exit code to <id>.done when it ends. The parent
      // exec is a different shell, so it cannot `wait`; the child self-reports via the done file.
      // The command runs in a sub-shell so its own `exit` cannot skip the done-file write; `$?` inside q() reaches
      // the inner bash unevaluated.
      const inner = `( ${command} ); echo $? > ${q(done)}`;
      // Setup runs synchronously; only the nohup'd job goes to the background (`&` would otherwise swallow the
      // whole `&&` chain), and its pid is recorded in the same statement.
      const script =
        `mkdir -p ${q(jobsDir)}; cd ${q(env.cwd ?? "~")}; ` +
        `{ nohup bash -c ${q(inner)} > ${q(log)} 2>&1 & echo $! > ${q(`${jobsDir}/${id}.pid`)}; }`;
      const r = await env.exec(script, undefined, context);
      if (!r.ok) throw new Error(`cannot start job: ${r.error?.message ?? "unknown"}`);
      await api.commit(async (tx) => {
        const doc = await tx.doc(JobsDoc);
        const ids = Object.keys(doc.jobs);
        if (ids.length >= MAX_JOBS) for (const old of ids.sort((a, b) => (doc.jobs[a].startedAt ?? 0) - (doc.jobs[b].startedAt ?? 0))) delete doc.jobs[old];
        doc.jobs[id] = {
          id,
          command,
          label: args.label ? String(args.label).slice(0, 80) : command.slice(0, 80),
          botConversationId: api.conversationId,
          logPath: log,
          startedAt: now(),
          status: "running",
        };
      }, context);
      return { output: [{ type: "text", text: `job ${id} started${args.label ? ` (${args.label})` : ""}; log: ${log}. Wait with job_wait {jobId: "${id}"}.` }] };
    },
  });

  const probeScript = (id) =>
    `if [ -f ${q(`${jobsDir}/${id}.done`)} ]; then echo "done $(cat ${q(`${jobsDir}/${id}.done`)})"; ` +
    `elif [ -f ${q(`${jobsDir}/${id}.pid`)} ] && kill -0 "$(cat ${q(`${jobsDir}/${id}.pid`)})" 2>/dev/null; then echo running; ` +
    `else echo unknown; fi`;

  const jobWait = defineTool({
    name: "job_wait",
    description:
      "Wait for a background job to finish and return its exit code and the tail of its log. Polls the sandbox about once a second.",
    parameters: Type.Object({
      jobId: Type.String({ description: "Job id from start_job" }),
      timeoutSec: Type.Optional(Type.Number({ minimum: 1, maximum: 3600, description: "Give up waiting after this many seconds (job keeps running); default 600" })),
    }),
    replay: "safe",
    async execute(args, api, context) {
      const env = api.env;
      if (!env) throw new Error("job_wait needs an execution environment");
      const deadline = now() + Math.min(3600, Math.max(1, args.timeoutSec ?? 600)) * 1000;
      let state = "unknown";
      while (now() < deadline) {
        const r = await runCapture(env, probeScript(args.jobId), context, { maxChars: 500 });
        if (r.ok && r.value.trim()) {
          state = r.value.trim();
          if (state.startsWith("done")) break;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      if (!state.startsWith("done")) {
        return { output: [{ type: "text", text: state === "running" ? `job ${args.jobId} still running after timeout` : `job ${args.jobId} not found` }], isError: state !== "running" };
      }
      const exitCode = Number(state.split(/\s+/)[1] ?? "0");
      const tail = await runCapture(env, `tail -c 4000 ${q(`${jobsDir}/${args.jobId}.log`)} 2>/dev/null`, context);
      await api.commit(async (tx) => {
        const doc = await tx.doc(JobsDoc);
        const job = doc.jobs[args.jobId];
        if (job) {
          job.status = "done";
          job.exitCode = exitCode;
          job.endedAt = now();
        }
      }, context);
      return {
        output: [
          {
            type: "text",
            text: `job ${args.jobId} finished with exit code ${exitCode}\n--- log tail ---\n${tail.ok ? tail.value : "(log unreadable)"}`,
          },
        ],
        isError: exitCode !== 0,
      };
    },
  });

  const jobStatus = defineTool({
    name: "job_status",
    description: "Check a background job without waiting: running or done, plus the log tail.",
    parameters: Type.Object({ jobId: Type.String({ description: "Job id from start_job" }) }),
    replay: "safe",
    async execute(args, api, context) {
      const env = api.env;
      if (!env) throw new Error("job_status needs an execution environment");
      const r = await runCapture(env, probeScript(args.jobId), context, { maxChars: 500 });
      const state = r.ok ? r.value.trim() : "unknown";
      const tail = await runCapture(env, `tail -c 2000 ${q(`${jobsDir}/${args.jobId}.log`)} 2>/dev/null`, context);
      return { output: [{ type: "text", text: `job ${args.jobId}: ${state || "unknown"}\n--- log tail ---\n${tail.ok ? tail.value : "(no log)"}` }] };
    },
  });

  return defineExtension({ name: "tarsbot.jobs", tools: [startJob, jobWait, jobStatus] });
}

export const Jobs = createJobs();
