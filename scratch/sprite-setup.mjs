// S3-setup: idempotent initialisation of the TARSBot Sprite (docs/SPRITES-PLAN.md §4.3). Run via scripts/sprite-setup.sh.
//   node --env-file=.env scratch/sprite-setup.mjs [--no-policy] [--reset-policy] [--recheckpoint] [--no-npm]
// Every step prints OK / SKIP / FAIL. Operates ONLY on $TARSBOT_SPRITE_NAME (never lists other Sprites).
// Secrets come from process.env only; they are never printed (all output is redacted) and never written to the Sprite:
// GITHUB_TOKEN is sent per exec as GH_TOKEN (see src/sandbox/sprites.mjs).
import { SpritesClient } from "@fly/sprites";
import { createSpritesBash, redactMessage } from "../src/sandbox/sprites.mjs";

const args = new Set(process.argv.slice(2));
const KNOWN = new Set(["--no-policy", "--reset-policy", "--recheckpoint", "--no-npm"]);
for (const a of args) {
  if (!KNOWN.has(a)) {
    console.error(`unknown option ${a}; supported: ${[...KNOWN].join(" ")}`);
    process.exit(2);
  }
}

const REPO = "hifizz/tars-sandbox-playground";
const REPO_URL = `https://github.com/${REPO}.git`;
const CHECKPOINT_COMMENT = "v-setup";
const CHECK_DIR = "/tmp/setup-check";
const CRED_HELPER = '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f';
/** Domains the Bot needs. Everything else is denied by the trailing wildcard rule. */
const ALLOW_DOMAINS = [
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  "release-assets.githubusercontent.com", // gh release / binary downloads redirect here
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
];
const DESIRED_RULES = [...ALLOW_DOMAINS.map((domain) => ({ action: "allow", domain })), { action: "deny", domain: "*" }];
const REQUIRED_REACHABLE = ["github.com", "api.github.com", "codeload.github.com", "objects.githubusercontent.com", "raw.githubusercontent.com", "registry.npmjs.org", "pypi.org", "files.pythonhosted.org"];

// ---------------------------------------------------------------- config / output
const need = (k) => {
  const v = process.env[k];
  if (!v) {
    console.error(`sprite-setup: ${k} is not set (put it in .env)`);
    process.exit(2);
  }
  return v;
};
const TOKEN = need("SPRITES_TOKEN");
const NAME = need("TARSBOT_SPRITE_NAME");
const GH = need("GITHUB_TOKEN");
const GIT_EMAIL = need("TARSBOT_GIT_EMAIL");
const SECRETS = [TOKEN, GH];

const redact = (s) => redactMessage(String(s ?? ""), SECRETS);
let failures = 0;
const results = [];
function report(status, step, detail = "") {
  if (status === "FAIL") failures++;
  results.push({ status, step });
  console.log(`${status.padEnd(4)}  ${step}${detail ? ` — ${redact(detail)}` : ""}`);
}
const info = (s) => console.log(`      ${redact(s)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const tail = (s, n = 12) => String(s).trim().split("\n").slice(-n).join("\n      ");

const client = new SpritesClient(TOKEN);
const sprite = client.sprite(NAME);
const bash = createSpritesBash({ client, name: NAME, env: { GH_TOKEN: GH }, secrets: [TOKEN] });

/** Run a shell script on the Sprite. Never throws: returns {out, err, code, ms, timedOut, error}. */
async function sh(script, timeoutMs = 120_000) {
  const t0 = Date.now();
  try {
    const r = await bash(script, { timeoutMs });
    return { out: redact(r.stdout), err: redact(r.stderr), code: r.exitCode ?? -1, ms: Date.now() - t0, timedOut: r.timedOut };
  } catch (e) {
    return { out: "", err: "", code: -1, ms: Date.now() - t0, error: redact(e.message) };
  }
}
const ok = (r) => r.code === 0 && !r.timedOut && !r.error;
const why = (r) => r.error ?? (r.timedOut ? "timed out" : `exit ${r.code}: ${tail(r.err || r.out, 4)}`);

// ---------------------------------------------------------------- steps
async function stepSprite() {
  try {
    const s = await client.getSprite(NAME);
    report("SKIP", "1 sprite exists", `${NAME} (status ${s.status})`);
    return true;
  } catch (e) {
    if (e?.statusCode !== 404 && !/404|not found/i.test(String(e?.message))) {
      report("FAIL", "1 sprite exists", `cannot query ${NAME}: ${redact(e.message).slice(0, 200)}`);
      return false;
    }
  }
  try {
    // Requested size; the server may ignore it (docs/SPRITES-PLAN.md §11). The SDK has no region list API, so region is
    // only sent when TARSBOT_SPRITE_REGION is set.
    const config = {
      cpus: Number(process.env.TARSBOT_SPRITE_CPUS || 4),
      ramMB: Number(process.env.TARSBOT_SPRITE_RAM_MB || 4096),
    };
    if (process.env.TARSBOT_SPRITE_REGION) config.region = process.env.TARSBOT_SPRITE_REGION;
    const s = await client.createSprite(NAME, { config, waitForCapacity: true });
    report("OK", "1 sprite created", `${NAME} (status ${s.status}; requested ${JSON.stringify(config)})`);
    return true;
  } catch (e) {
    report("FAIL", "1 sprite created", redact(e.message).slice(0, 300));
    return false;
  }
}

async function stepGh() {
  const have = await sh("command -v gh >/dev/null && gh --version | head -1");
  if (ok(have)) return report("SKIP", "2 gh installed", have.out.trim());
  // Not preinstalled: fetch the release tarball from github.com (allowed by the policy) into ~/.local; no sudo/apt needed.
  const r = await sh(
    `set -e
v=$(curl -fsS https://api.github.com/repos/cli/cli/releases/latest | jq -r .tag_name | sed 's/^v//')
[ -n "$v" ]
mkdir -p "$HOME/.local" /tmp/gh-install
curl -fsSL -o /tmp/gh-install/gh.tgz "https://github.com/cli/cli/releases/download/v$v/gh_$(printf %s "$v")_linux_amd64.tar.gz"
tar -xzf /tmp/gh-install/gh.tgz -C "$HOME/.local" --strip-components=1
rm -rf /tmp/gh-install
"$HOME/.local/bin/gh" --version | head -1`,
    300_000,
  );
  if (ok(r)) report("OK", "2 gh installed", `${r.out.trim()} (in ~/.local/bin; make sure it is on PATH)`);
  else report("FAIL", "2 gh installed", why(r));
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
  const had = await sh("test -d /home/sprite/workspace");
  if (ok(had)) return report("SKIP", "4 ~/workspace", "exists");
  const r = await sh("mkdir -p /home/sprite/workspace");
  report(ok(r) ? "OK" : "FAIL", "4 ~/workspace", ok(r) ? "created" : why(r));
}

const rulesKey = (rules) => JSON.stringify((rules ?? []).map((r) => [r.action, r.domain ?? r.include ?? ""]));

/** Probe reachability from inside the Sprite. Returns {host: http_code_string}. */
async function probeHosts(hosts, timeoutSec = 8) {
  const script = hosts
    .map((h) => `printf '%s ' ${shq(h)}; curl -sS -o /dev/null -m ${timeoutSec} -w '%{http_code}' ${shq(`https://${h}/`)} 2>/dev/null; echo`)
    .join("\n");
  const r = await sh(script, 180_000);
  const map = {};
  for (const line of r.out.split("\n")) {
    const [h, code] = line.trim().split(/\s+/);
    if (h) map[h] = code ?? "000";
  }
  return map;
}
const reachable = (code) => /^[1-5]\d\d$/.test(code ?? "") && code !== "000";

async function verifyPolicy() {
  const allowed = await probeHosts(REQUIRED_REACHABLE);
  const unreachable = REQUIRED_REACHABLE.filter((h) => !reachable(allowed[h]));
  // Policy changes take effect within ~1 s (P9); retry a few times before judging "still reachable".
  let blockedCode = "?";
  for (let i = 0; i < 10; i++) {
    blockedCode = (await probeHosts(["example.com"], 5))["example.com"];
    if (!reachable(blockedCode)) break;
    await sleep(1000);
  }
  return { unreachable, blocked: !reachable(blockedCode), blockedCode, allowed };
}

async function stepPolicy() {
  if (args.has("--no-policy")) return report("SKIP", "5 network policy", "--no-policy");
  if (args.has("--reset-policy")) {
    try {
      await sprite.updateNetworkPolicy({ rules: [] });
      return report("OK", "5 network policy", "reset to unrestricted (--reset-policy); rerun without it to re-apply");
    } catch (e) {
      return report("FAIL", "5 network policy", `reset failed: ${redact(e.message).slice(0, 200)}`);
    }
  }
  let current;
  try {
    current = await sprite.getNetworkPolicy();
  } catch (e) {
    return report("FAIL", "5 network policy", `cannot read policy: ${redact(e.message).slice(0, 200)}`);
  }
  const same = rulesKey(current.rules) === rulesKey(DESIRED_RULES);
  if (!same) {
    try {
      await sprite.updateNetworkPolicy({ rules: DESIRED_RULES });
    } catch (e) {
      return report("FAIL", "5 network policy", `update failed: ${redact(e.message).slice(0, 200)}`);
    }
    await sleep(1500);
  }
  const v = await verifyPolicy();
  if (v.unreachable.length) {
    // Never leave the Sprite cut off from GitHub: roll back to unrestricted.
    let rolled = "rollback failed - run with --reset-policy";
    try {
      await sprite.updateNetworkPolicy({ rules: [] });
      rolled = "rolled back to unrestricted";
    } catch {
      // reported above
    }
    return report("FAIL", "5 network policy", `allowlisted hosts unreachable: ${v.unreachable.join(", ")}; ${rolled}`);
  }
  if (!v.blocked) {
    return report("FAIL", "5 network policy", `policy ${same ? "present" : "applied"} but example.com is still reachable (http ${v.blockedCode})`);
  }
  report(same ? "SKIP" : "OK", "5 network policy", `${same ? "already in place" : "applied"}: ${ALLOW_DOMAINS.length} domains allowed, everything else denied`);
}

function cmpNodeMajor(v) {
  const m = /^v?(\d+)\./.exec(v.trim());
  return m ? Number(m[1]) : 0;
}

async function stepVerify() {
  // 6.1 git ls-remote + gh repo view (token only via GH_TOKEN env + credential helper)
  const ls = await sh(`git ls-remote ${shq(REPO_URL)} HEAD | cut -c1-12`);
  report(ok(ls) && ls.out.trim() ? "OK" : "FAIL", "6.1 git ls-remote", ok(ls) ? `HEAD ${ls.out.trim()}…` : why(ls));
  const gv = await sh(`gh repo view ${shq(REPO)} --json nameWithOwner,visibility,defaultBranchRef --jq '.nameWithOwner + " " + .visibility + " default=" + .defaultBranchRef.name'`);
  report(ok(gv) ? "OK" : "FAIL", "6.2 gh repo view", ok(gv) ? gv.out.trim() : why(gv));

  // 6.3 clone + node + npm install + npm test
  if (args.has("--no-npm")) {
    report("SKIP", "6.3 clone / node / npm install / npm test", "--no-npm");
  } else {
    await sh(`rm -rf ${CHECK_DIR}`);
    try {
      const clone = await sh(`git clone -q ${shq(REPO_URL)} ${CHECK_DIR}/repo`, 300_000);
      if (!ok(clone)) {
        report("FAIL", "6.3 git clone", why(clone));
      } else {
        report("OK", "6.3 git clone", `${(clone.ms / 1000).toFixed(1)}s (credential helper, no token in URL)`);
        const nv = await sh("node -v");
        const major = cmpNodeMajor(nv.out);
        report(ok(nv) && major >= 24 ? "OK" : "FAIL", "6.4 node >= 24", ok(nv) ? nv.out.trim() : why(nv));
        // Output goes to a file so the real exit status survives the `tail` (dash has no pipefail).
        const inst = await sh(`cd ${CHECK_DIR}/repo && npm install --no-audit --no-fund >../npm-install.log 2>&1; rc=$?; tail -n 25 ../npm-install.log; exit $rc`, 900_000);
        const installed = ok(inst);
        report(installed ? "OK" : "FAIL", "6.5 npm install", `${(inst.ms / 1000).toFixed(1)}s${installed ? "" : `\n      ${tail(inst.out || why(inst), 25)}`}`);
        if (installed) {
          const test = await sh(`cd ${CHECK_DIR}/repo && npm test >../npm-test.log 2>&1; rc=$?; tail -n 300 ../npm-test.log; exit $rc`, 900_000);
          const body = test.out;
          // node --test prints "# pass N" (TAP) or "ℹ pass N" (spec reporter).
          const passed = ok(test) && /^(#|ℹ) fail 0$/m.test(body) && /^(#|ℹ) pass [1-9]/m.test(body);
          const sum = body.split("\n").filter((l) => /^(#|ℹ) (tests|pass|fail|skipped|duration_ms)/.test(l)).map((l) => l.replace(/^(#|ℹ) /, "")).join(", ");
          report(passed ? "OK" : "FAIL", "6.6 npm test", `${(test.ms / 1000).toFixed(1)}s ${sum}${passed ? "" : `\n      ${tail(body)}`}`);
        }
      }
    } finally {
      const rm = await sh(`rm -rf ${CHECK_DIR}; test ! -e ${CHECK_DIR}`);
      report(ok(rm) ? "OK" : "FAIL", "6.7 cleanup " + CHECK_DIR, ok(rm) ? "removed" : why(rm));
    }
  }

  // 6.8 network policy effect (only meaningful when a policy is expected)
  if (args.has("--no-policy") || args.has("--reset-policy")) {
    report("SKIP", "6.8 policy effect", "policy not managed in this run");
  } else {
    const p = await sprite.getNetworkPolicy().catch(() => ({ rules: [] }));
    if (rulesKey(p.rules) !== rulesKey(DESIRED_RULES)) report("SKIP", "6.8 policy effect", "policy not in place");
    else {
      const v = await verifyPolicy();
      const good = v.blocked && !v.unreachable.length;
      report(good ? "OK" : "FAIL", "6.8 policy effect", `example.com blocked=${v.blocked}(${v.blockedCode}); allowlisted unreachable=[${v.unreachable.join(",")}]`);
    }
  }

  // 6.9 no token on the Sprite's disk or git config. The command text never contains the token (it is only in env).
  const leak = await sh(`[ -n "$GH_TOKEN" ] || { echo no-token-in-env; exit 3; }
grep -rIlF -e "$GH_TOKEN" /home/sprite 2>/dev/null | head -5
echo "---"
grep -rIl -e 'ghp_' -e 'github_pat_' --exclude-dir=.npm --exclude-dir=node_modules --exclude-dir=.cache --exclude-dir=.grok /home/sprite 2>/dev/null | head -5
echo "---"
git config --global -l | grep -cF -e "$GH_TOKEN" || true`, 300_000);
  if (!ok(leak)) report("FAIL", "6.9 no token on disk", why(leak));
  else {
    const [exact, pattern, cfg] = leak.out.split("---\n").map((s) => s.trim());
    const clean = !exact && !pattern && cfg === "0";
    report(clean ? "OK" : "FAIL", "6.9 no token on disk / in git config", clean ? "exact-value grep, ghp_/github_pat_ grep and git config -l: no hits" : `exact hits: [${exact}] pattern hits: [${pattern}] git-config hits: ${cfg}`);
  }
}

async function stepCheckpoint() {
  if (failures > 0) return report("SKIP", "7 checkpoint v-setup", "earlier step failed; not snapshotting a broken setup");
  let list;
  try {
    list = await sprite.listCheckpoints();
  } catch (e) {
    return report("FAIL", "7 checkpoint v-setup", `cannot list checkpoints: ${redact(e.message).slice(0, 200)}`);
  }
  const existing = list.filter((c) => c.comment === CHECKPOINT_COMMENT);
  if (existing.length && !args.has("--recheckpoint")) {
    return report("SKIP", "7 checkpoint v-setup", `exists as ${existing.map((c) => c.id).join(",")} (use --recheckpoint to replace)`);
  }
  let newId;
  try {
    const stream = await sprite.createCheckpoint(CHECKPOINT_COMMENT);
    await stream.processAll((m) => {
      const mm = /Path: checkpoints\/(\S+)/.exec(String(m.data ?? ""));
      if (mm) newId = mm[1];
    });
  } catch (e) {
    return report("FAIL", "7 checkpoint v-setup", `create failed: ${redact(e.message).slice(0, 200)}`);
  }
  // Checkpoint ids are server-assigned (v1, v2…); the name "v-setup" is stored as the comment.
  const notes = [];
  for (const old of existing) {
    // Create first, delete after: a failed create never leaves us without a checkpoint.
    try {
      const res = await fetch(`https://api.sprites.dev/v1/sprites/${encodeURIComponent(NAME)}/checkpoints/${encodeURIComponent(old.id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${TOKEN}` },
        signal: AbortSignal.timeout(60_000),
      });
      notes.push(res.ok ? `replaced ${old.id}` : `could not delete old ${old.id} (HTTP ${res.status})`);
    } catch (e) {
      notes.push(`could not delete old ${old.id}: ${redact(e.message).slice(0, 80)}`);
    }
  }
  report("OK", "7 checkpoint v-setup", `created ${newId ?? "(id unknown)"} comment="${CHECKPOINT_COMMENT}"${notes.length ? `; ${notes.join("; ")}` : ""}`);
}

// ---------------------------------------------------------------- main
console.log(`sprite-setup: target Sprite "${NAME}"${[...args].length ? ` (${[...args].join(" ")})` : ""}`);
try {
  if (await stepSprite()) {
    await stepGh();
    await stepGit();
    await stepWorkspace();
    await stepPolicy();
    await stepVerify();
    await stepCheckpoint();
  }
} catch (e) {
  report("FAIL", "unexpected error", redact(e?.stack ?? e).split("\n").slice(0, 4).join(" | "));
}
const count = (s) => results.filter((r) => r.status === s).length;
console.log(`\nsprite-setup: ${count("OK")} OK, ${count("SKIP")} SKIP, ${count("FAIL")} FAIL`);
process.exit(failures ? 1 : 0);
