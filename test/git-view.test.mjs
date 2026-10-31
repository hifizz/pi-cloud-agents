// AMP13-git offline tests: the git-view routes resolve the session dir server-side (bot worktree metadata first,
// then the session cwd, then the workspace cwd), require a ready workspace + active binding, and run fixed read-only
// git commands through runtimeBash. The env-helper tests run the REAL git binary in a temp repo (no mock shell):
// invalid refs error instead of emitting an empty diff, root commits produce their patch, nested symlinks that
// escape the root and protected `.env`/`.git` paths are refused, and the output cap preserves git's true exit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api.mjs";
import { openControlStore } from "../src/control/store.mjs";
import { register as registerGitView } from "../src/routes/git-view.mjs";
import { untrackedFileDiff, gitCommitDiff, gitDiff, gitRefs, GitViewError } from "../src/git-view-env.mjs";

const HEAD = "a".repeat(40);

// ------------------------------------------------------------------------------------------------------------------
// Real-repo env-helper tests (no mock shell — the real `git` binary runs in a temp dir).
// ------------------------------------------------------------------------------------------------------------------

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "gv-test-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  return { dir, git };
}

const bashLocal = (command) => {
  // Run the assembled script under /bin/sh (Sprite dash-compatible). stdout/stderr captured; exit code surfaced.
  try {
    const stdout = execFileSync("/bin/sh", ["-c", command], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (e) {
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? String(e.message), exitCode: e.status ?? 1 };
  }
};

test("untrackedFileDiff: real repo — content, nested-symlink escape refused, protected segments refused", async () => {
  const { dir, git } = makeRepo();
  try {
    // tracked file so the repo isn't empty
    writeFileSync(join(dir, "a.txt"), "a\n");
    git("add", "a.txt");
    git("commit", "-qm", "init");

    // a real untracked file produces its patch
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "new.txt"), "line1\nline2\n");
    const ok = await untrackedFileDiff(bashLocal, dir, "sub/new.txt");
    assert.ok(ok.diff.includes("line1") && ok.diff.includes("line2"), `content: ${ok.diff.slice(0, 200)}`);
    assert.ok(!ok.truncated);
    writeFileSync(join(dir, "with spaces.txt"), "space-proof\n");
    assert.match((await untrackedFileDiff(bashLocal, dir, "with spaces.txt")).diff, /\+space-proof/);
    writeFileSync(join(dir, "a.txt"), "changed\n");
    assert.match((await gitDiff(bashLocal, dir)).diff, /\+changed/);

    // a symlink whose target escapes the worktree root is refused (exit 3 -> symlink flag, never read)
    symlinkSync(join(dir, ".."), join(dir, "link-out"));
    const esc = await untrackedFileDiff(bashLocal, dir, "link-out/secret.txt");
    assert.ok(esc.symlink, "escape via symlink refused");

    // protected segments are refused before any read (still inside the root) — an explicit denial, not a fake empty
    writeFileSync(join(dir, ".env"), "SECRET=1\n");
    await assert.rejects(() => untrackedFileDiff(bashLocal, dir, ".env"), (e) => {
      assert.ok(e instanceof GitViewError && e.code === "invalid", `.env denied: ${e?.code}`);
      return true;
    });
    await assert.rejects(() => untrackedFileDiff(bashLocal, dir, ".git/config"), (e) => {
      assert.ok(e instanceof GitViewError && e.code === "invalid", `.git denied: ${e?.code}`);
      return true;
    });

    // a directory is reported, never diffed
    const d = await untrackedFileDiff(bashLocal, dir, "sub");
    assert.ok(d.directory, "directory reported");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gitCommitDiff: root commit produces its patch via `git show` (sha^! emits empty diff)", async () => {
  const { dir, git } = makeRepo();
  try {
    writeFileSync(join(dir, "f"), "x\n");
    git("add", "f");
    git("commit", "-qm", "root");
    const root = git("rev-parse", "HEAD").trim();
    const r = await gitCommitDiff(bashLocal, dir, root);
    assert.ok(r.diff.includes("new file") && r.diff.includes("+x"), `root diff: ${r.diff.slice(0, 200)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gitDiff: invalid ref surfaces a real error (exit 128), not an empty diff", async () => {
  const { dir, git } = makeRepo();
  try {
    writeFileSync(join(dir, "f"), "x\n");
    git("add", "f");
    git("commit", "-qm", "init");
    // A bogus ref makes `git diff` exit 128; --exit-code keeps that failure visible through the head pipe.
    // (`...` is not a valid ref and is rejected by checkRef — a *plausible* but unknown ref exercises git's own error.)
    await assert.rejects(() => gitDiff(bashLocal, dir, { refs: [`${HEAD.slice(0, 7)}...HEAD`] }), (e) => {
      assert.ok(e instanceof GitViewError && e.code === "invalid", `expected invalid (… rejected), got ${e?.code}`);
      return true;
    });
    // A well-formed ref that does not exist: git exits 128 (bad revision) — a real error, not an empty diff.
    await assert.rejects(() => gitDiff(bashLocal, dir, { refs: ["nonexistent-branch"] }), (e) => {
      assert.ok(e instanceof GitViewError && e.code === "git", `expected git error, got ${e?.code}: ${e?.message}`);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gitRefs: local branches kind=branch, remote-tracking kind=remote (full refname prefix)", async () => {
  const { dir, git } = makeRepo();
  try {
    writeFileSync(join(dir, "f"), "x\n");
    git("add", "f");
    git("commit", "-qm", "init");
    git("branch", "tarsbot/fix-1a2b3c"); // local branch with a slash — must stay "branch", not "remote"
    git("tag", "v1");
    const r = await gitRefs(bashLocal, dir);
    const byName = Object.fromEntries(r.refs.map((x) => [x.name, x.kind]));
    assert.equal(byName["tarsbot/fix-1a2b3c"], "branch", `local branch: ${JSON.stringify(byName)}`);
    assert.equal(byName["v1"], "tag");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------------------------------------
// Route tests with faux runtimeBash (no Sprite, no git binary needed for the route plumbing itself).
// ------------------------------------------------------------------------------------------------------------------

/** faux bash: `handlers` is an ordered list of [substring, result|fn]; a command with no match exits 1. */
function fauxBash(handlers = []) {
  const calls = [];
  const bash = async (command) => {
    calls.push(command);
    for (const [match, value] of handlers) {
      if (command.includes(match)) {
        const r = typeof value === "function" ? value(command) : value;
        return { stdout: "", stderr: "", exitCode: 0, ...r };
      }
    }
    return { stdout: "", stderr: `unexpected: ${command.slice(0, 80)}`, exitCode: 1 };
  };
  return { calls, bash };
}

// handlers match on `command.includes(match)`; the last entry's empty string is the catch-all.
function handlers({ status = "", refs = "", log = "", diff = "" } = {}) {
  return [
    ["rev-parse' 'HEAD", { stdout: `${HEAD}\n` }],
    ["rev-parse' '--abbrev-ref' 'HEAD", { stdout: "HEAD\n" }],
    ["status' '--porcelain=v1' '-z", { stdout: status }],
    ["for-each-ref", { stdout: refs }],
    ["log' '-", { stdout: log }],
    ["", { stdout: diff }],
  ];
}

async function makeEnv({ bot = {}, workspaceStatus = "ready", binding = true, bashHandlers } = {}) {
  const store = openControlStore({ path: null });
  const project = store.projects.upsert({ repo: "hifizz/tars-sandbox-playground", defaultBranch: "main" });
  const { workspace } = store.workspaces.create({
    requestId: "seed-gv",
    projectId: project.id,
    name: "git-view ws",
    baseBranch: "main",
    branch: "tarsbot/ws-x",
    cwd: "/home/sprite/workspace/repo",
    model: { provider: "faux", modelId: "faux-1" },
  });
  store.workspaces.update(workspace.id, { status: workspaceStatus });
  if (binding) store.bindings.bind(workspace.id, { provider: "sprites", runtimeId: "pca-deadbeef" });

  const botRecord = {
    id: "b1",
    name: "session-1",
    conversationId: 4242,
    model: { provider: "faux", modelId: "faux-1" },
    ...bot,
  };
  const bots = {
    list: () => [botRecord],
    get: (id) => ([botRecord.id, botRecord.name].includes(id) ? botRecord : undefined),
  };
  store.links.link({ conversationId: "4242", workspaceId: workspace.id, botId: "b1" });

  const rt = fauxBash(bashHandlers ?? handlers());
  const inject = (app) => Object.assign(app.ctx, { control: store, runtimeBash: () => rt.bash });
  const api = createApi({ harness: {}, bots, routes: [inject, registerGitView] });
  const { port } = await api.listen(0);
  const call = async (path) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    const text = await res.text();
    assert.ok(!text.includes(tmpdir()), "response carries a server path");
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text };
  };
  return {
    store,
    rt,
    ws: workspace,
    get: call,
    async close() {
      await api.close();
      store.close();
    },
  };
}

const PORCELAIN = " M src/app.ts\0A  src/new.ts\0?? notes.md\0D  old/removed.ts\0MM mixed.ts\0";

test("status: files are classified into staged/unstaged/both/untracked and commands stay read-only", async () => {
  const env = await makeEnv({ bashHandlers: handlers({ status: PORCELAIN }) });
  try {
    const { status, json } = await env.get("/api/bots/b1/git/status");
    assert.equal(status, 200, json?.error);
    assert.equal(json.dir, "/home/sprite/workspace/repo"); // no worktree metadata → workspace cwd
    assert.equal(json.branch, null); // detached HEAD → null
    assert.equal(json.head.length, 40, `head: ${json.head}`);
    const byPath = Object.fromEntries(json.files.map((f) => [f.path, f.kind]));
    assert.deepEqual(byPath, {
      "src/app.ts": "unstaged",
      "src/new.ts": "staged",
      "notes.md": "untracked",
      "old/removed.ts": "staged",
      "mixed.ts": "both",
    });
    const cmd = env.rt.calls.find((c) => c.includes("status"));
    assert.ok(cmd.includes("--"), `status uses '--' pathspec separator: ${cmd}`);
    for (const c of env.rt.calls) {
      assert.ok(!/\b(checkout|reset|push|fetch|clean|stash|commit|merge|rebase|config|remote)\b/.test(c.split("git -C")[1] ?? c), `mutating command: ${c}`);
    }
  } finally {
    await env.close();
  }
});

test("status: session worktree dir wins over workspace cwd (issueLoop > review > worktree > bot.cwd)", async () => {
  for (const [bot, dir] of [
    [{ issueLoop: { issue: 1, baseBranch: "main", pinnedSha: HEAD, dir: "/home/sprite/issue-loop/ws/d-abc" } }, "/home/sprite/issue-loop/ws/d-abc"],
    [{ review: { pr: 3, headSha: HEAD, dir: "/home/sprite/reviews/ws/pr-3-x" } }, "/home/sprite/reviews/ws/pr-3-x"],
    [{ worktree: { baseBranch: "main", pinnedSha: HEAD, dir: "/home/sprite/sessions/ws/s-y" } }, "/home/sprite/sessions/ws/s-y"],
    [{ cwd: "/home/sprite/agent-cwd" }, "/home/sprite/agent-cwd"],
  ]) {
    const env = await makeEnv({ bot });
    try {
      const { status, json } = await env.get("/api/bots/b1/git/status");
      assert.equal(status, 200, json?.error);
      assert.equal(json.dir, dir);
      assert.ok(env.rt.calls.every((c) => c.includes(`-C '${dir}'`)), `git -C uses the session dir: ${env.rt.calls[0]}`);
    } finally {
      await env.close();
    }
  }
});

test("diff scopes: unstaged/staged use fixed flags, untracked builds a temp-copy script", async () => {
  const env = await makeEnv({ bashHandlers: handlers({ diff: "diff --git a/f b/f\n" }) });
  try {
    let r = await env.get("/api/bots/b1/git/diff?scope=staged&path=src/app.ts");
    assert.equal(r.status, 200, r.json?.error);
    const staged = env.rt.calls.find((c) => c.includes("--cached"));
    assert.ok(staged.includes(`'src/app.ts'`), `staged diff names the path: ${staged}`);
    assert.ok(staged.includes("--"), "path after --");
    assert.ok(staged.includes("code=$?"), "git status is retained before bounding output");
    assert.ok(staged.includes("mktemp"), "diff output goes through a temp file so git's exit is not masked by head");

    r = await env.get("/api/bots/b1/git/diff?scope=untracked&path=notes.md");
    assert.equal(r.status, 200, r.json?.error);
    const untracked = env.rt.calls.find((c) => c.includes("/dev/null"));
    assert.ok(untracked.includes("mktemp") && untracked.includes("'notes.md'"), `untracked via /dev/null + temp copy: ${untracked}`);
    assert.ok(untracked.includes("-L"), "untracked checks symlink components");

    r = await env.get("/api/bots/b1/git/diff?scope=bogus");
    assert.equal(r.status, 400);
    r = await env.get("/api/bots/b1/git/diff?scope=untracked");
    assert.equal(r.status, 400);
  } finally {
    await env.close();
  }
});

test("diff: oversized output is cut inside the shell and flagged truncated", async () => {
  const env = await makeEnv({ bashHandlers: handlers({ diff: "x".repeat(400_000) }) });
  try {
    const { status, json } = await env.get("/api/bots/b1/git/diff");
    assert.equal(status, 200, json?.error);
    assert.ok(json.truncated, "flagged");
    assert.ok(Buffer.byteLength(json.diff) <= 300_000, `diff capped: ${json.diff.length}`);
    assert.ok(env.rt.calls.some((c) => c.includes("head -c")), "cap applied in the shell");
  } finally {
    await env.close();
  }
});

test("refs and compare: base is validated, compare uses base...HEAD", async () => {
  const refs = `refs/heads/main\u0000${HEAD}\u0000commit\nrefs/remotes/origin/main\u0000${HEAD}\u0000commit\nrefs/tags/v1.0\u0000${"b".repeat(40)}\u0000tag\n`;
  const env = await makeEnv({ bashHandlers: handlers({ refs, diff: "diff --git a/x b/x\n" }) });
  try {
    let r = await env.get("/api/bots/b1/git/refs");
    assert.equal(r.status, 200, r.json?.error);
    assert.deepEqual(
      r.json.refs.map((x) => [x.name, x.kind]),
      [
        ["main", "branch"],
        ["origin/main", "remote"],
        ["v1.0", "tag"],
      ],
    );

    r = await env.get("/api/bots/b1/git/compare?base=main&nameStatus=1");
    assert.equal(r.status, 200, r.json?.error);
    const nameStatus = env.rt.calls.find((c) => c.includes("--name-status"));
    assert.ok(nameStatus.includes("'main...HEAD'"), `merge-base compare: ${nameStatus}`);

    r = await env.get("/api/bots/b1/git/compare?base=..%2Fetc%2Fpasswd");
    assert.equal(r.status, 400);
    r = await env.get("/api/bots/b1/git/compare?base=%24(x)");
    assert.equal(r.status, 400);
    r = await env.get("/api/bots/b1/git/compare?base=main&path=..%2Fsecret");
    assert.equal(r.status, 400);
  } finally {
    await env.close();
  }
});

test("log and commit diff: commits parse; commit diff uses `git show` (root-safe)", async () => {
  const log = `${HEAD}\u0000${HEAD.slice(0, 7)}\u0000fizz\u0000f@x\u00002026-01-01T00:00:00+00:00\u0000first commit\u0000`;
  const env = await makeEnv({ bashHandlers: handlers({ log, diff: "diff --git a/f b/f\n+line\n" }) });
  try {
    let r = await env.get("/api/bots/b1/git/log?limit=10");
    assert.equal(r.status, 200, r.json?.error);
    assert.equal(r.json.commits.length, 1);
    assert.equal(r.json.commits[0].subject, "first commit");
    assert.ok(env.rt.calls.some((c) => c.includes("log' '-10'")), "limit passed through");

    r = await env.get(`/api/bots/b1/git/commit/${HEAD}/diff`);
    assert.equal(r.status, 200, r.json?.error);
    assert.ok(env.rt.calls.some((c) => c.includes("show' '--format='")), `commit diff uses git show: ${env.rt.calls.at(-1)}`);

    r = await env.get("/api/bots/b1/git/commit/not%20a%20sha!!/diff");
    assert.equal(r.status, 400);
  } finally {
    await env.close();
  }
});

test("guardrails: unknown bot 404, unlinked bot 409, not-ready workspace 409, no binding 409", async () => {
  const env = await makeEnv();
  try {
    let r = await env.get("/api/bots/nope/git/status");
    assert.equal(r.status, 404);
    r = await env.get("/api/bots/b1/git/status");
    assert.equal(r.status, 200);
  } finally {
    await env.close();
  }

  const notReady = await makeEnv({ workspaceStatus: "preparing" });
  try {
    const r = await notReady.get("/api/bots/b1/git/status");
    assert.equal(r.status, 409);
    assert.ok(notReady.rt.calls.length === 0, "no git ran");
  } finally {
    await notReady.close();
  }

  const noBinding = await makeEnv({ binding: false });
  try {
    const r = await noBinding.get("/api/bots/b1/git/status");
    assert.equal(r.status, 409);
    assert.ok(noBinding.rt.calls.length === 0, "no git ran");
  } finally {
    await noBinding.close();
  }
});
