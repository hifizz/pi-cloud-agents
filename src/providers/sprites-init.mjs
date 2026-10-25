// Idempotent per-runtime initialisation. `initCommon` (gh, git identity + credential helper) runs on any provider's
// bash primitive; `initSprite` adds the Sprite-only network policy step. Rewritten from scratch/sprite-setup.mjs for
// per-workspace Sprites (docs/M1-PLAN.md §4.3). The GitHub token is only ever passed through the exec env (GH_TOKEN)
// by the caller's bash primitive; it never lands on the machine's disk or in git config. No npm self-check.

export const CRED_HELPER = '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f';

/** Same allowlist as scratch/sprite-setup.mjs; everything else is denied by the trailing wildcard rule. */
export const ALLOW_DOMAINS = [
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
];
export const DESIRED_RULES = [...ALLOW_DOMAINS.map((domain) => ({ action: "allow", domain })), { action: "deny", domain: "*" }];

const rulesKey = (rules) => JSON.stringify((rules ?? []).map((r) => [r.action, r.domain ?? r.include ?? ""]));
export const sameRules = (a, b) => rulesKey(a) === rulesKey(b);

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const GH_INSTALL = `set -e
v=$(curl -fsS https://api.github.com/repos/cli/cli/releases/latest | jq -r .tag_name | sed 's/^v//')
[ -n "$v" ]
mkdir -p "$HOME/.local" /tmp/gh-install
curl -fsSL -o /tmp/gh-install/gh.tgz "https://github.com/cli/cli/releases/download/v$v/gh_$(printf %s "$v")_linux_amd64.tar.gz"
tar -xzf /tmp/gh-install/gh.tgz -C "$HOME/.local" --strip-components=1
rm -rf /tmp/gh-install
"$HOME/.local/bin/gh" --version | head -1`;

/**
 * Provider-agnostic init steps (gh, git identity + credential helper) over any provider's bash primitive.
 * @param {object} o
 * @param {(cmd: string, opts?: {timeoutMs?: number}) => Promise<{stdout: string, stderr: string, exitCode?: number, timedOut?: boolean}>} o.bash
 * @param {string} [o.gitEmail]
 * @param {string} [o.gitName]
 * @param {boolean} [o.credentialHelper] set the credential helper (only useful when a token is configured)
 * @param {string} [o.ghProbe] probe command that exits 0 when gh is already installed (providers pass their own paths)
 * @param {(s: string) => string} [o.redact]
 * @param {string} [o.what] label for error messages (e.g. "sprite init")
 * @returns {Promise<{steps: {step: string, state: "done"|"skipped", detail?: string}[]}>} throws on the first failing step
 */
export async function initCommon({
  bash,
  gitEmail,
  gitName = "TARSBot",
  credentialHelper = true,
  ghProbe = "command -v gh >/dev/null 2>&1 || test -x /.sprite/bin/gh || test -x \"$HOME/.local/bin/gh\"",
  redact = (s) => s,
  what = "init",
} = {}) {
  const steps = [];
  const sh = async (script, timeoutMs = 120_000) => {
    const r = await bash(script, { timeoutMs });
    return { out: String(r.stdout ?? ""), err: String(r.stderr ?? ""), ok: r.exitCode === 0 && !r.timedOut, timedOut: r.timedOut, code: r.exitCode };
  };
  const fail = (step, r) => {
    const why = r.timedOut ? "timed out" : `exit ${r.code}: ${(r.err || r.out).trim().split("\n").slice(-3).join(" | ")}`;
    throw new Error(redact(`${what} step "${step}" failed: ${why}`));
  };

  // 1. gh: Sprites already ship it (/.sprite/bin); probe before installing.
  const have = await sh(ghProbe);
  if (have.ok) steps.push({ step: "gh", state: "skipped", detail: "already installed" });
  else {
    const r = await sh(GH_INSTALL, 300_000);
    if (!r.ok) fail("gh", r);
    steps.push({ step: "gh", state: "done", detail: "installed to ~/.local/bin" });
  }

  // 2. git identity + credential helper
  const want = [];
  if (credentialHelper) want.push(["credential.https://github.com.helper", CRED_HELPER]);
  want.push(["user.name", gitName]);
  if (gitEmail) want.push(["user.email", gitEmail]);
  const changed = [];
  for (const [key, value] of want) {
    const cur = await sh(`git config --global --get-all ${shq(key)}`);
    if (cur.ok && cur.out.replace(/\n$/, "") === value) continue;
    const set = await sh(`git config --global --unset-all ${shq(key)}; git config --global ${shq(key)} ${shq(value)}`);
    if (!set.ok) fail(`git config ${key}`, set);
    changed.push(key);
  }
  steps.push({ step: "git", state: changed.length ? "done" : "skipped", detail: changed.length ? `updated ${changed.join(", ")}` : "already set" });
  return { steps };
}

/**
 * Per-Sprite initialisation: initCommon plus the network policy step.
 * @param {object} o
 * @param {(cmd: string, opts?: {timeoutMs?: number}) => Promise<{stdout: string, stderr: string, exitCode?: number, timedOut?: boolean}>} o.bash
 * @param {{getNetworkPolicy(): Promise<{rules: object[]}>, updateNetworkPolicy(p: {rules: object[]}): Promise<void>}} o.sprite
 * @param {string} [o.gitEmail]
 * @param {string} [o.gitName]
 * @param {boolean} [o.credentialHelper] set the credential helper (only useful when a token is configured)
 * @returns {Promise<{steps: {step: string, state: "done"|"skipped", detail?: string}[]}>} throws on the first failing step
 */
export async function initSprite({ bash, sprite, gitEmail, gitName = "TARSBot", credentialHelper = true, redact = (s) => s }) {
  const { steps } = await initCommon({ bash, gitEmail, gitName, credentialHelper, redact, what: "sprite init" });

  // 3. network policy
  const current = await sprite.getNetworkPolicy();
  if (sameRules(current?.rules, DESIRED_RULES)) steps.push({ step: "network", state: "skipped", detail: "policy already applied" });
  else {
    await sprite.updateNetworkPolicy({ rules: DESIRED_RULES });
    steps.push({ step: "network", state: "done", detail: "policy applied" });
  }
  return { steps };
}
