// E3-setup: idempotent creation + initialisation of the shared E2B sandbox (docs/E2B-PLAN.md). Run via scripts/e2b-setup.sh.
//   node --env-file=.env scratch/e2b-setup.mjs [--no-npm] [--recreate]
// Every step prints OK / SKIP / FAIL. Operates ONLY on the sandbox with metadata {app:"pi-cloud-agents", name:"pi-cloud-agents"}.
// Secrets come from process.env only and are never printed or written to the sandbox: GITHUB_TOKEN is sent per command
// as GH_TOKEN (see src/sandbox/e2b.mjs), exactly like the Bot does.
import { Sandbox } from "e2b";
import { e2bBash, findE2bSandbox, redactMessage } from "../src/sandbox/e2b.mjs";

const args = new Set(process.argv.slice(2));
const KNOWN = new Set(["--no-npm", "--recreate"]);
for (const a of args) {
  if (!KNOWN.has(a)) {
    console.error(`unknown option ${a}; supported: ${[...KNOWN].join(" ")}`);
    process.exit(2);
  }
}

const APP = "pi-cloud-agents";
const REQUIRED_NAME = "pi-cloud-agents";
const REPO = "hifizz/tars-sandbox-playground";
const REPO_URL = `https://github.com/${REPO}.git`;
const REPO_DIR = "~/workspace/tars-sandbox-playground";
const MARKER = "~/.e2b-setup-marker";
const CRED_HELPER = '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f';
const MIN_GH = [2, 40];

const need = (k) => {
  const v = process.env[k];
  if (!v) {
    console.error(`e2b-setup: ${k} is not set (put it in .env)`);
    process.exit(2);
  }
  return v;
};
const NAME = process.env.TARSBOT_E2B_NAME || REQUIRED_NAME;
if (NAME !== REQUIRED_NAME) {
  console.error(`e2b-setup: refusing to run: TARSBOT_E2B_NAME must be exactly "${REQUIRED_NAME}" (got "${NAME}")`);
  process.exit(2);
}
process.env.TARSBOT_E2B_NAME = NAME; // the production primitive reads this
const API_KEY = need("E2B_API_KEY");
const GH = need("GITHUB_TOKEN");
const GIT_EMAIL = need("TARSBOT_GIT_EMAIL");
const TEMPLATE = process.env.TARSBOT_E2B_TEMPLATE || "base";
const IDLE_MS = Math.min(Number(process.env.TARSBOT_E2B_IDLE_MS) > 0 ? Number(process.env.TARSBOT_E2B_IDLE_MS) : 600_000, 3_600_000);
const SECRETS = [API_KEY, GH];

const redact = (s) => redactMessage(String(s ?? ""), SECRETS);
let failures = 0;
const results = [];
function report(status, step, detail = "") {
  if (status === "FAIL") failures++;
  results.push({ status, step });
  console.log(`${status.padEnd(4)}  ${step}${detail ? ` — ${redact(detail)}` : ""}`);
}
const info = (s) => console.log(`      ${redact(s).split("\n").join("\n      ")}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const tail = (s, n = 12) => String(s).trim().split("\n").slice(-n).join("\n      ");

/** Run a shell command through the production primitive (what the Bot uses). Never throws. */
async function sh(script, timeoutMs = 120_000) {
  const t0 = Date.now();
  try {
    const r = await e2bBash(script, { timeoutMs });
    return { out: redact(r.stdout), err: redact(r.stderr), code: r.exitCode ?? -1, ms: Date.now() - t0, timedOut: r.timedOut };
  } catch (e) {
    return { out: "", err: "", code: -1, ms: Date.now() - t0, error: redact(e.message) };
  }
}
const ok = (r) => r.code === 0 && !r.timedOut && !r.error;
const why = (r) => r.error ?? (r.timedOut ? "timed out" : `exit ${r.code}: ${tail(r.err || r.out, 4)}`);

/** All sandboxes (running or paused) with our metadata. */
async function listOurs() {
  const p = Sandbox.list({ apiKey: API_KEY, query: { metadata: { app: APP, name: NAME }, state: ["running", "paused"] }, limit: 10 });
  const items = [];
  do items.push(...(await p.nextItems()));
  while (p.hasNext);
  return items;
}

let sandboxId;

function cmpNodeMajor(v) {
  const m = /^v?(\d+)\./.exec(v.trim());
  return m ? Number(m[1]) : 0;
}

// ---------------------------------------------------------------- steps
async function stepSandbox() {
  let found = await listOurs();
  if (found.length > 1) {
    report("FAIL", "1 sandbox", `${found.length} sandboxes named ${NAME}: ${found.map((s) => `${s.sandboxId}(${s.state})`).join(", ")}; not deleting any - remove extras manually`);
    return false;
  }
  if (found.length === 1 && args.has("--recreate")) {
    const old = found[0].sandboxId;
    try {
      await Sandbox.kill(old, { apiKey: API_KEY });
    } catch (e) {
      report("FAIL", "1 sandbox", `--recreate: could not kill ${old}: ${redact(e.message).slice(0, 200)}`);
      return false;
    }
    info(`--recreate: killed ${old}`);
    found = [];
  }
  if (found.length === 1) {
    try {
      const sb = await findE2bSandbox({ Sandbox, apiKey: API_KEY, name: NAME, timeoutMs: IDLE_MS }); // resumes when paused
      sandboxId = sb?.sandboxId ?? found[0].sandboxId;
    } catch (e) {
      report("FAIL", "1 sandbox", `exists (${found[0].sandboxId}) but connect failed: ${redact(e.message).slice(0, 200)}`);
      return false;
    }
    report("SKIP", "1 sandbox exists", `${NAME} id=${sandboxId} (was ${found[0].state})`);
  } else {
    try {
      // lifecycle: pause on timeout (E-D3: persistence = pause, never kill). autoResume:false because the runtime always
      // resumes explicitly with Sandbox.connect(id) before running a command (src/sandbox/e2b.mjs); E1 measured this combination.
      const sb = await Sandbox.create(TEMPLATE, {
        apiKey: API_KEY,
        metadata: { app: APP, name: NAME },
        timeoutMs: IDLE_MS,
        lifecycle: { onTimeout: "pause", autoResume: false },
      });
      sandboxId = sb.sandboxId;
      report("OK", "1 sandbox created", `${NAME} id=${sandboxId} template=${TEMPLATE} timeout=${IDLE_MS}ms lifecycle={onTimeout:"pause",autoResume:false}`);
    } catch (e) {
      report("FAIL", "1 sandbox created", redact(e.message).slice(0, 300));
      return false;
    }
  }
  const spec = await sh(`echo "user=$(id -un) home=$HOME"; echo "nproc=$(nproc)"; free -m; df -h ~`);
  if (ok(spec)) info(spec.out.trim());
  else report("FAIL", "1 spec", why(spec));
  try {
    const i = await Sandbox.getInfo(sandboxId, { apiKey: API_KEY });
    info(`template=${i.name ?? i.templateId} cpu=${i.cpuCount} memoryMB=${i.memoryMB} lifecycle=${JSON.stringify(i.lifecycle)} endAt=${i.endAt instanceof Date ? i.endAt.toISOString() : i.endAt}`);
  } catch (e) {
    info(`getInfo failed: ${redact(e.message).slice(0, 120)}`);
  }
  return true;
}

const PATH_BLOCK = `# pi-cloud-agents: ~/.local/bin on PATH
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$HOME/.local/bin:$PATH"; export PATH ;; esac`;

async function stepTools() {
  // 2.0 swap: the base template has 473 MB RAM and no swap; npm ci / npm test get OOM-killed ("Killed") without it.
  const hasSwap = await sh("grep -q '^/swapfile ' /proc/swaps");
  if (ok(hasSwap)) {
    report("SKIP", "2.0 swap", "/swapfile active");
  } else {
    const r = await sh(
      `set -e
[ -f /swapfile ] || { sudo -n fallocate -l 1G /swapfile && sudo -n chmod 600 /swapfile && sudo -n mkswap /swapfile >/dev/null; }
sudo -n swapon /swapfile
free -m | tail -1`,
    );
    report(ok(r) ? "OK" : "FAIL", "2.0 swap", ok(r) ? `1 GB /swapfile enabled (${r.out.trim().replace(/\s+/g, " ")})` : why(r));
  }

  // 2a apt packages that are missing (rg / sqlite3 are not in the base template; the rest should already be there)
  const apt = { git: "git", curl: "curl", jq: "jq", python3: "python3", node: "nodejs", npm: "npm", rg: "ripgrep", sqlite3: "sqlite3" };
  const missing = [];
  for (const cmd of Object.keys(apt)) if (!ok(await sh(`command -v ${cmd} >/dev/null`))) missing.push(cmd);
  if (missing.length) {
    const pk = missing.map((c) => apt[c]).join(" ");
    const r = await sh(`sudo -n env DEBIAN_FRONTEND=noninteractive sh -c 'apt-get update -qq && apt-get install -y -qq ${pk}' >/tmp/apt.log 2>&1; rc=$?; tail -n 5 /tmp/apt.log; exit $rc`, 600_000);
    report(ok(r) ? "OK" : "FAIL", "2.1 apt packages", ok(r) ? `installed ${pk}` : why(r));
  } else {
    report("SKIP", "2.1 apt packages", "git curl jq python3 node npm rg sqlite3 present");
  }

  // 2b gh: the Debian package is old (2.23); install the release tarball into ~/.local when older than MIN_GH or missing
  const cur = await sh(`gh --version 2>/dev/null | head -1 | sed 's/^gh version \\([0-9.]*\\).*/\\1/'`);
  const [maj, min] = cur.out.trim().split(".").map(Number);
  const fresh = ok(cur) && (maj > MIN_GH[0] || (maj === MIN_GH[0] && min >= MIN_GH[1]));
  if (fresh) {
    report("SKIP", "2.2 gh installed", `gh ${cur.out.trim()}`);
  } else {
    const r = await sh(
      `set -e
v=$(curl -fsS https://api.github.com/repos/cli/cli/releases/latest | jq -r .tag_name | sed 's/^v//')
[ -n "$v" ]
case "$(uname -m)" in x86_64) a=amd64 ;; aarch64|arm64) a=arm64 ;; *) echo "unsupported arch" >&2; exit 1 ;; esac
mkdir -p "$HOME/.local" /tmp/gh-install
curl -fsSL -o /tmp/gh-install/gh.tgz "https://github.com/cli/cli/releases/download/v$v/gh_\${v}_linux_$a.tar.gz"
tar -xzf /tmp/gh-install/gh.tgz -C "$HOME/.local" --strip-components=1
rm -rf /tmp/gh-install
"$HOME/.local/bin/gh" --version | head -1`,
      300_000,
    );
    report(ok(r) ? "OK" : "FAIL", "2.2 gh installed", ok(r) ? `${r.out.trim()} (~/.local/bin; was ${cur.out.trim() || "missing"})` : why(r));
  }

  // 2b' node: the base template ships node 20 (`node --test` does not expand globs there); the test repo and the Bot
  // expect >= 24 like the Sprite. Install the official tarball (checksum verified) into ~/.local, ahead of /usr/local on PATH.
  const nv = await sh("~/.local/bin/node -v 2>/dev/null || node -v");
  if (ok(nv) && cmpNodeMajor(nv.out) >= 24) {
    report("SKIP", "2.2b node >= 24", nv.out.trim());
  } else {
    const r = await sh(
      `set -e
case "$(uname -m)" in x86_64) a=x64 ;; aarch64|arm64) a=arm64 ;; *) echo "unsupported arch" >&2; exit 1 ;; esac
base=https://nodejs.org/dist/latest-v24.x
mkdir -p "$HOME/.local" /tmp/node-install
curl -fsSL -o /tmp/node-install/SHASUMS256.txt "$base/SHASUMS256.txt"
f=$(grep "linux-$a.tar.xz\\$" /tmp/node-install/SHASUMS256.txt | awk '{print $2}')
[ -n "$f" ]
curl -fsSL -o "/tmp/node-install/$f" "$base/$f"
(cd /tmp/node-install && grep " $f\\$" SHASUMS256.txt | sha256sum -c - >/dev/null)
tar -xJf "/tmp/node-install/$f" -C "$HOME/.local" --strip-components=1 --exclude='*/CHANGELOG.md' --exclude='*/LICENSE' --exclude='*/README.md'
rm -rf /tmp/node-install
"$HOME/.local/bin/node" -v`,
      600_000,
    );
    report(ok(r) ? "OK" : "FAIL", "2.2b node >= 24", ok(r) ? `${r.out.trim()} (~/.local/bin; was ${nv.out.trim() || "missing"})` : why(r));
  }

  // 2c PATH: ~/.local/bin for login bash (the SDK runs `/bin/bash -l -c`), which the inner sh -c / bash -c inherit.
  const files = await sh(`for f in ~/.profile ~/.bash_profile ~/.bash_login; do [ -e "$f" ] && echo "$f"; done; true`);
  const targets = new Set(["~/.profile", ...files.out.split("\n").filter(Boolean).map((f) => f.replace(process.env.HOME ?? "\0", "~"))]);
  let changed = 0;
  for (const f of targets) {
    const target = f.startsWith("/") ? shq(f) : f;
    const have = await sh(`grep -qF 'pi-cloud-agents: ~/.local/bin on PATH' ${target}`);
    if (ok(have)) continue;
    const w = await sh(`touch ${target} && printf '\\n%s\\n' ${shq(PATH_BLOCK)} >> ${target}`);
    if (!ok(w)) return report("FAIL", "2.3 PATH", `${f}: ${why(w)}`);
    changed++;
  }
  // Verify through the production primitive, in both shells the Bot's commands run under.
  const sh1 = await sh("which gh && which git");
  const sh2 = await sh("/bin/bash -c 'which gh && gh --version | head -1'");
  const good = ok(sh1) && ok(sh2) && sh1.out.includes(".local/bin/gh") && sh2.out.includes(".local/bin/gh");
  const allOk = ["git", "gh", "node", "npm", "python3", "curl", "jq"];
  const wh = await sh(allOk.map((c) => `command -v ${c} >/dev/null || echo MISSING:${c}`).join("\n"));
  const lacking = wh.out.split("\n").filter((l) => l.startsWith("MISSING:"));
  if (!good || lacking.length) {
    return report("FAIL", "2.3 PATH / tools via e2bBash", `sh: ${ok(sh1) ? sh1.out.trim().replace(/\n/g, " ") : why(sh1)}; bash -c: ${ok(sh2) ? sh2.out.trim().replace(/\n/g, " ") : why(sh2)}; ${lacking.join(" ")}`);
  }
  report(changed ? "OK" : "SKIP", "2.3 PATH / tools via e2bBash", `${changed ? `updated ${changed} profile file(s); ` : ""}which gh -> ${sh1.out.split("\n")[0]} (sh -c and bash -c)`);
}

async function stepGit() {
  const want = [
    ["credential.https://github.com.helper", CRED_HELPER],
    ["user.name", "TARSBot"],
    ["user.email", GIT_EMAIL],
  ];
  const changed = [];
  for (const [key, value] of want) {
    const cur = await sh(`git config --global --get-all ${shq(key)}`);
    if (ok(cur) && cur.out.replace(/\n$/, "") === value) continue;
    const set = await sh(`git config --global --unset-all ${shq(key)}; git config --global ${shq(key)} ${shq(value)}`);
    if (!ok(set)) return report("FAIL", "3 git config", `${key}: ${why(set)}`);
    changed.push(key);
  }
  if (changed.length) report("OK", "3 git credential helper + identity", `updated ${changed.join(", ")}`);
  else report("SKIP", "3 git credential helper + identity", `already set (user.email=${GIT_EMAIL})`);
}

async function stepWorkspace() {
  const had = await sh("test -d ~/workspace");
  if (ok(had)) return report("SKIP", "4 ~/workspace", "exists");
  const r = await sh("mkdir -p ~/workspace && cd ~/workspace && pwd");
  report(ok(r) ? "OK" : "FAIL", "4 ~/workspace", ok(r) ? `created ${r.out.trim()}` : why(r));
}

async function stepVerify() {
  // 5.1 versions
  const vers = await sh(`for c in "git --version" "gh --version" "node --version" "npm --version" "python3 --version" "jq --version"; do $c 2>&1 | head -1; done`);
  const lines = vers.out.trim().split("\n");
  report(ok(vers) && lines.length === 6 && cmpNodeMajor(lines[2]) >= 24 ? "OK" : "FAIL", "5.1 versions", ok(vers) ? lines.join("; ") : why(vers));

  // 5.2 remote access with GH_TOKEN injected by the primitive
  const ls = await sh(`git ls-remote ${shq(REPO_URL)} HEAD | cut -c1-12`);
  report(ok(ls) && ls.out.trim() ? "OK" : "FAIL", "5.2 git ls-remote", ok(ls) ? `HEAD ${ls.out.trim()}…` : why(ls));
  const gv = await sh(`gh repo view ${shq(REPO)} --json nameWithOwner,visibility,defaultBranchRef --jq '.nameWithOwner + " " + .visibility + " default=" + .defaultBranchRef.name'`);
  report(ok(gv) ? "OK" : "FAIL", "5.3 gh repo view", ok(gv) ? gv.out.trim() : why(gv));

  // 5.4 clone/fetch + npm ci + npm test
  if (args.has("--no-npm")) {
    report("SKIP", "5.4 clone / npm ci / npm test", "--no-npm");
  } else {
    const exists = await sh(`test -d ${REPO_DIR}/.git`);
    let ready;
    if (ok(exists)) {
      const f = await sh(`cd ${REPO_DIR} && git fetch -q origin && git status -sb | head -3`, 300_000);
      ready = ok(f);
      report(ready ? "SKIP" : "FAIL", "5.4 repo present", ready ? `fetched; ${f.out.trim().replace(/\n/g, " | ")}` : why(f));
    } else {
      const c = await sh(`git clone -q ${shq(REPO_URL)} ${REPO_DIR}`, 300_000);
      ready = ok(c);
      report(ready ? "OK" : "FAIL", "5.4 git clone", ready ? `${(c.ms / 1000).toFixed(1)}s (credential helper, no token in URL)` : why(c));
    }
    if (ready) {
      const inst = await sh(
        `cd ${REPO_DIR} && if [ -f package-lock.json ]; then cmd="npm ci"; else cmd="npm install"; fi; $cmd --no-audit --no-fund >/tmp/npm-install.log 2>&1; rc=$?; echo "cmd=$cmd"; tail -n 25 /tmp/npm-install.log; exit $rc`,
        900_000,
      );
      report(ok(inst) ? "OK" : "FAIL", "5.5 npm ci", `${(inst.ms / 1000).toFixed(1)}s ${ok(inst) ? inst.out.split("\n")[0] : `\n      ${tail(inst.out || why(inst), 25)}`}`);
      if (ok(inst)) {
        const test = await sh(`cd ${REPO_DIR} && npm test >/tmp/npm-test.log 2>&1; rc=$?; tail -n 300 /tmp/npm-test.log; exit $rc`, 900_000);
        const body = test.out;
        // node --test prints "# pass N" (TAP) or "ℹ pass N" (spec reporter).
        const passed = ok(test) && /^(#|ℹ) fail 0$/m.test(body) && /^(#|ℹ) pass [1-9]/m.test(body);
        const sum = body.split("\n").filter((l) => /^(#|ℹ) (tests|pass|fail|skipped|duration_ms)/.test(l)).map((l) => l.replace(/^(#|ℹ) /, "")).join(", ");
        report(passed ? "OK" : "FAIL", "5.6 npm test", `${(test.ms / 1000).toFixed(1)}s ${sum}${passed ? "" : `\n      ${tail(body)}`}`);
      }
    }
  }

  // 5.7 no token on the sandbox disk. The value only travels in the env (GH_TOKEN); the command text never contains it.
  const leak = await sh(
    `[ -n "$GH_TOKEN" ] || { echo no-token-in-env; exit 3; }
grep -rIlF -e "$GH_TOKEN" --exclude-dir=node_modules ~ 2>/dev/null | head -5
echo "---"
git config --global -l | grep -cF -e "$GH_TOKEN" || true`,
    300_000,
  );
  if (!ok(leak)) report("FAIL", "5.7 no token on disk", why(leak));
  else {
    const [hits, cfg] = leak.out.split("---\n").map((s) => s.trim());
    const clean = !hits && cfg === "0";
    report(clean ? "OK" : "FAIL", "5.7 no token on disk / in git config", clean ? "exact-value grep over ~ (excl. node_modules) and git config -l: no hits" : `file hits: ${hits ? hits.split("\n").length : 0}; git-config hits: ${cfg}`);
  }

  // 5.8 pause / resume
  await stepPauseResume();
}

async function stepPauseResume() {
  const stamp = String(Date.now());
  const w = await sh(`printf %s ${shq(stamp)} > ${MARKER} && cat ${MARKER}`);
  if (!ok(w) || w.out.trim() !== stamp) return report("FAIL", "5.8 pause/resume", `cannot write marker: ${why(w)}`);
  let tPause;
  try {
    const t0 = Date.now();
    await Sandbox.pause(sandboxId, { apiKey: API_KEY });
    tPause = Date.now() - t0;
  } catch (e) {
    return report("FAIL", "5.8 pause/resume", `pause failed: ${redact(e.message).slice(0, 200)}`);
  }
  let state = "?";
  for (let i = 0; i < 20; i++) {
    state = (await listOurs()).find((s) => s.sandboxId === sandboxId)?.state ?? "gone";
    if (state === "paused") break;
    await sleep(500);
  }
  if (state !== "paused") return report("FAIL", "5.8 pause/resume", `after pause list says ${state}, expected paused`);
  const r = await sh(`cat ${MARKER} && echo && which gh`);
  const [got, ghPath] = r.out.trim().split("\n");
  const after = (await listOurs()).find((s) => s.sandboxId === sandboxId)?.state ?? "gone";
  const good = ok(r) && got === stamp && !!ghPath;
  report(
    good ? "OK" : "FAIL",
    "5.8 pause/resume",
    `pause ${tPause} ms; state=paused; transparent resume via e2bBash in ${r.ms} ms; marker ${got === stamp ? "identical" : `MISMATCH (${got})`}; which gh=${ghPath}; state after=${after}${good ? "" : ` ${why(r)}`}`,
  );
}

async function stepFinal() {
  const mine = (await listOurs()).find((s) => s.sandboxId === sandboxId);
  const end = mine?.endAt ? new Date(mine.endAt) : undefined;
  const left = end ? Math.round((end.getTime() - Date.now()) / 1000) : undefined;
  report("OK", "6 final state", `id=${sandboxId} state=${mine?.state ?? "?"}${left !== undefined ? ` remaining timeout ~${left}s (endAt ${end.toISOString()})` : ""}; sandbox kept (not killed)`);
}

// ---------------------------------------------------------------- main
console.log(`e2b-setup: target sandbox "${NAME}" template=${TEMPLATE}${[...args].length ? ` (${[...args].join(" ")})` : ""}`);
try {
  if (await stepSandbox()) {
    await stepTools();
    await stepGit();
    await stepWorkspace();
    await stepVerify();
    await stepFinal();
  }
} catch (e) {
  report("FAIL", "unexpected error", redact(e?.stack ?? e).split("\n").slice(0, 4).join(" | "));
}
const count = (s) => results.filter((r) => r.status === s).length;
console.log(`\ne2b-setup: ${count("OK")} OK, ${count("SKIP")} SKIP, ${count("FAIL")} FAIL`);
process.exit(failures ? 1 : 0);
