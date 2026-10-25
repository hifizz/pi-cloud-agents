// InstaBox setup: idempotent creation + initialisation of the shared machine "pi-cloud-agents" (docs/INSTABOX-PLAN.md).
//   node scripts/instabox-setup.mjs [--recreate] [--delete] [--no-init]
//     --recreate  delete the existing machine (ours only: exact name + label app=pi-cloud-agents) and create a fresh one
//     --delete    delete the machine (ours only) and exit
//     --no-init   skip the in-machine initialisation (workspace, git, tools)
// Every step prints OK / SKIP / FAIL; exit status 1 if any step FAILs. Operates ONLY on the machine named
// TARSBOT_INSTABOX_NAME (must be exactly "pi-cloud-agents"); deletion additionally requires our label.
// Secrets come from process.env / .env only (run with `node --env-file=.env`) and are never printed or written to
// the machine: GITHUB_TOKEN goes per command as GH_TOKEN, exactly like the Bot does (src/sandbox/instabox.mjs).
import { instaboxApi, findInstaboxMachine, createInstaboxBash, redactMessage } from "../src/sandbox/instabox.mjs";

const args = new Set(process.argv.slice(2));
const KNOWN = new Set(["--recreate", "--delete", "--no-init"]);
for (const a of args) {
  if (!KNOWN.has(a)) {
    console.error(`instabox-setup: unknown option ${a}; supported: ${[...KNOWN].join(" ")}`);
    process.exit(2);
  }
}

const APP = "pi-cloud-agents";
const REQUIRED_NAME = "pi-cloud-agents";
const WORKSPACE = "/data/home/workspace";
const CRED_HELPER = '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f';

const need = (k) => {
  const v = process.env[k];
  if (!v) {
    console.error(`instabox-setup: ${k} is not set (put it in .env)`);
    process.exit(2);
  }
  return v;
};
const NAME = process.env.TARSBOT_INSTABOX_NAME || REQUIRED_NAME;
if (NAME !== REQUIRED_NAME) {
  console.error(`instabox-setup: refusing to run: TARSBOT_INSTABOX_NAME must be exactly "${REQUIRED_NAME}" (got "${NAME}")`);
  process.exit(2);
}
const API_KEY = need("INSTABOX_API_KEY");
const BASE_URL = process.env.INSTABOX_BASE_URL;
const GH = args.has("--delete") ? process.env.GITHUB_TOKEN : need("GITHUB_TOKEN");
const GIT_EMAIL = args.has("--delete") ? process.env.TARSBOT_GIT_EMAIL : need("TARSBOT_GIT_EMAIL");
const AUTO_SUSPEND_SEC = Number(process.env.TARSBOT_INSTABOX_AUTO_SUSPEND_SEC);
const SECRETS = [API_KEY, GH].filter(Boolean);

const redact = (s) => redactMessage(String(s ?? ""), SECRETS);
let failures = 0;
function report(status, step, detail = "") {
  if (status === "FAIL") failures++;
  console.log(`${status.padEnd(4)}  ${step}${detail ? ` — ${redact(detail)}` : ""}`);
}
const info = (s) => console.log(`      ${redact(s).split("\n").join("\n      ")}`);
const ourLabel = (m) => m?.metadata?.app === APP;

const client = instaboxApi({ apiKey: API_KEY, baseUrl: BASE_URL });
// Commands run through the production primitive (what the Bot uses): paused machines wake on exec, stopped ones are
// started + retried by it, so setup needs no lifecycle handling of its own.
const bash =
  args.has("--delete")
    ? null
    : createInstaboxBash({
        apiKey: API_KEY,
        baseUrl: BASE_URL,
        name: NAME,
        env: GH ? { GH_TOKEN: GH } : {},
      });

/** Run a shell command in the machine. Never throws. */
async function sh(script, timeoutMs = 180_000) {
  const t0 = Date.now();
  try {
    const r = await bash(script, { timeoutMs });
    return { out: redact(r.stdout), err: redact(r.stderr), code: r.exitCode ?? -1, ms: Date.now() - t0, timedOut: r.timedOut };
  } catch (e) {
    return { out: "", err: "", code: -1, ms: Date.now() - t0, error: redact(e.message) };
  }
}
const okRun = (r) => r.code === 0 && !r.timedOut && !r.error;
const why = (r) => r.error ?? (r.timedOut ? "timed out" : `exit ${r.code}: ${String(r.err || r.out).trim().split("\n").slice(-4).join(" | ")}`);

// ---------------------------------------------------------------- steps
/** Pick the create template: TARSBOT_INSTABOX_TEMPLATE_ID if set, else `agent-browser` (the only one free-plan keys
 *  may use), else the first listed. Returns {templateId, version}. */
async function pickTemplate() {
  const listed = (await client.listTemplates()).templates ?? [];
  if (listed.length === 0) throw new Error("GET /v1/templates returned no templates");
  const forced = process.env.TARSBOT_INSTABOX_TEMPLATE_ID;
  const chosen = forced ? listed.find((t) => t.id === forced) : (listed.find((t) => t.id === "agent-browser") ?? listed[0]);
  if (!chosen) throw new Error(`template "${forced}" not among: ${listed.map((t) => t.id).join(", ")}`);
  return chosen;
}

async function stepMachine() {
  let machine = await findInstaboxMachine({ apiKey: API_KEY, baseUrl: BASE_URL, name: NAME });
  if (machine && !ourLabel(machine)) {
    report("FAIL", "1 machine", `a machine named ${NAME} exists but carries no metadata app=${APP}; refusing to touch it`);
    return false;
  }
  if (machine && (args.has("--recreate") || args.has("--delete"))) {
    const action = args.has("--delete") ? "--delete" : "--recreate";
    try {
      const op = await client.deleteMachine(machine.id);
      await client.waitOperation(op, { timeoutMs: 300_000 });
    } catch (e) {
      report("FAIL", "1 machine", `${action}: delete failed: ${redact(e.message).slice(0, 200)}`);
      return false;
    }
    info(`${action}: deleted ${machine.id}`);
    machine = null;
  }
  if (machine) {
    report("SKIP", "1 machine exists", `${NAME} id=${machine.id} state=${machine.state} (template ${machine.template?.id ?? "?"})`);
    return true;
  }
  if (args.has("--delete")) {
    report("SKIP", "1 machine", `${NAME} does not exist; nothing to delete`);
    process.exit(failures ? 1 : 0);
  }
  try {
    const template = await pickTemplate();
    const body = { name: NAME, templateId: template.id, metadata: { app: APP } };
    if (Number.isFinite(AUTO_SUSPEND_SEC) && AUTO_SUSPEND_SEC >= 0) body.autoSuspendAfterSeconds = Math.floor(AUTO_SUSPEND_SEC);
    const op = await client.createMachine(body);
    const done = await client.waitOperation(op, { timeoutMs: 300_000 });
    if (done.state !== "succeeded") throw new Error(done.error?.message ?? done.error ?? `operation ${done.state}`);
    report("OK", "1 machine created", `${NAME} id=${done.machine?.id ?? "?"} (template ${template.id}@${template.version ?? "?"}, guest ${done.machine?.guestUser ?? "user"})`);
    return true;
  } catch (e) {
    const hint = /template_not_allowed/.test(String(e?.message)) ? " (free-plan keys may only create from the agent-browser template)" : "";
    report("FAIL", "1 machine", `create failed: ${redact(e.message).slice(0, 200)}${hint}`);
    return false;
  }
}

async function stepWorkspace() {
  const r = await sh(`mkdir -p -- ${WORKSPACE} && echo made`);
  report(okRun(r) ? "OK" : "FAIL", "2 workspace", okRun(r) ? WORKSPACE : why(r));
}

async function stepTools() {
  const r = await sh(`for t in git gh node npm python3 curl jq; do printf '%s=' "$t"; command -v "$t" >/dev/null 2>&1 && "$t" --version 2>/dev/null | head -1 || echo MISSING; done`);
  if (!okRun(r)) {
    report("FAIL", "3 tools", why(r));
    return;
  }
  const missing = [...r.out.matchAll(/^(\w+)=MISSING$/gm)].map((m) => m[1]);
  if (missing.length === 0) {
    report("OK", "3 tools", r.out.trim().split("\n").join(", "));
    return;
  }
  info(`missing: ${missing.join(", ")} — trying a best-effort apt install (needs passwordless sudo in the machine)`);
  const ghRepo = missing.includes("gh")
    ? "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo -n tee /usr/share/keyrings/githubcli.gpg >/dev/null && echo 'deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli.gpg] https://cli.github.com/packages stable main' | sudo -n tee /etc/apt/sources.list.d/github-cli.list >/dev/null && "
    : "";
  const apt = missing.filter((t) => t !== "gh").map((t) => (t === "node" ? "nodejs" : t)).join(" ");
  const install = await sh(
    `${ghRepo}sudo -n apt-get update -qq && sudo -n apt-get install -y -qq ${apt}${missing.includes("gh") ? " gh" : ""} >/dev/null; echo rc=$?`,
    300_000,
  );
  if (!okRun(install) || !/rc=0/.test(install.out)) {
    report("SKIP", "3 tools", `could not auto-install ${missing.join(", ")} (no sudo or no network); install them in the machine if the Bot needs them`);
    return;
  }
  const after = await sh(`for t in ${missing.join(" ")}; do printf '%s=' "$t"; command -v "$t" >/dev/null 2>&1 && echo yes || echo MISSING; done`);
  report("OK", "3 tools", `installed: ${after.out.trim().split("\n").join(", ")}`);
}

async function stepGit() {
  const r = await sh(
    `git config --global user.name TARSBot && git config --global user.email ${JSON.stringify(GIT_EMAIL)} && ` +
      `git config --global credential.helper ${JSON.stringify(CRED_HELPER)} && git config --global init.defaultBranch main && echo done`,
  );
  report(okRun(r) ? "OK" : "FAIL", "4 git identity + GH_TOKEN credential helper", okRun(r) ? `TARSBot <${GIT_EMAIL}>` : why(r));
}

async function stepSelfCheck() {
  const r = await sh(`echo -n selfcheck: && uname -sr && (command -v node >/dev/null && node -e "console.log('node', process.version)" || true)`);
  report(okRun(r) ? "OK" : "FAIL", "5 self-check exec", okRun(r) ? r.out.trim().split("\n").join(" | ") : why(r));
  const marker = await sh(`date -u +%Y-%m-%dT%H:%M:%SZ > ~/.instabox-setup-marker && echo marked`);
  report(okRun(marker) ? "OK" : "FAIL", "6 marker", okRun(marker) ? "~/.instabox-setup-marker" : why(marker));
}

const go = await stepMachine();
if (go && !args.has("--delete") && !args.has("--no-init")) {
  await stepWorkspace();
  await stepTools();
  await stepGit();
  await stepSelfCheck();
}
process.exit(failures ? 1 : 0);
