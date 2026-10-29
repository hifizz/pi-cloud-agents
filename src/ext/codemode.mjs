// Code mode (spec: pi-durable "Code Mode"): the `codemode` tool runs model-written JavaScript in a QuickJS sandbox
// (`@earendil-works/pi-codemode`); the script calls the conversation's other tools as `await tools.<name>(args)` —
// each a nested tool call that runs the same ToolTask hooks (Approval included), keeps its own replay policy, and
// journals its result, so the script resumes after a restart without re-running finished calls.
//
// Install BEFORE Approval: the extension order only decides registration order; nested calls go through the same
// ToolTask hooks either way, and keeping every tool registered before Approval keeps that invariant obvious.
//
// `details.fullOutputPath` (over-budget output spill): written through the conversation's ExecutionEnv
// (`env.createTempDir("pi-codemode-")` -> `mktemp -d /tmp/pi-codemode-*` in the workspace machine — the Sprite, not
// this host). The model reads it back with the `read` tool (offset/limit); the result text already tells it so.
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";

export const CODEMODE_EXTENSION_NAME = "codemode";

/**
 * @param {object} [opts]
 * @param {import("@earendil-works/pi-codemode/portable").CodemodeSandboxBase} [opts.sandbox] test hook: another sandbox
 * @param {number} [opts.memoryLimitBytes] QuickJS heap cap (default 256 MiB)
 * @param {number} [opts.timeoutMs] sandbox deadline per script; default Infinity (see below)
 * @param {boolean} [opts.models] give scripts `models.*` globals (classify, generateImages); default false
 * @param {number} [opts.inlineBudget] token budget of the tool declarations in the codemode prompt section
 * @param {readonly import("@earendil-works/pi-durable/codemode").CodemodeNamespace[]} [opts.namespaces]
 */
export function createCodemode(opts = {}) {
  return createCodemodeExtension({
    sandbox:
      opts.sandbox ??
      new CodemodeSandbox({
        memoryLimitBytes: opts.memoryLimitBytes ?? 256 * 1024 * 1024,
        // The sandbox's own default deadline (300 s) is wall clock, including time a nested call spends parked in
        // human approval — a wait that legitimately runs much longer here. No default deadline; a script's own
        // `timeout_ms` (// @options line) still applies, and an abort still interrupts the VM.
        timeoutMs: opts.timeoutMs ?? Number.POSITIVE_INFINITY,
      }),
    models: opts.models ?? false,
    ...(opts.inlineBudget === undefined ? {} : { inlineBudget: opts.inlineBudget }),
    ...(opts.namespaces === undefined ? {} : { namespaces: opts.namespaces }),
  });
}

export const Codemode = createCodemode();
