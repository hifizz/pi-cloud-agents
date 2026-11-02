# Loops Phase 2 — implementation notes (Issue14)

Branch `feat/loops-phase-2`, worktree `pi-cloud-agents-loops`. Phase 1 (`0fd371f`) is untouched except
where noted; all prior loop behavior is preserved.

## 1. Data flow

```
GitHub App webhook  ──► POST /api/github/webhook ──► verifyGithubWebhook (HMAC, inside global guard)
                                                          │ raw body read once, capped 256KB
                                                          ▼
repo events feed   ──► loops.github.poll (durable task) ──► normalizePollEvent ───────────────┐
Checks API (open PRs) ──► check_suite-shaped supplement ──► same ingest path                  │
                                                          ▼                                   │
                                        ingestGithubEvent ──► github_deliveries.mark(canonicalKey)
                                                          │ first ingest only; fan-out to EVERY
                                                          │ enabled github_* loop (no global swallow)
                                                          ▼
                                        matchesTrigger (kind gate, events[], filters, self-comment)
                                        startsMatching edge (loop_match_state) for condition events
                                                          ▼
                                        queue.enqueue(triggerKey = "gh:" + canonicalKey)
                                                          │
                                                          ▼  UNIQUE(loop_id, trigger_key) — per-destination dedup
                                        runner.runOne ──► worktree ──► Session(+LoopApproval,
                                          +LoopGithubToolsExt when capabilities.github.* on)
                                                          ▼
                                        send_github_* tools (deferred, offered via modelTools.add)
                                        → Approval always → github client (server-held token)
                                        → run artifacts (pr_number, payload.suggestedTask, payload.pr)
```

Two dedup layers, deliberately separated (Issue13 review note): `github_deliveries` marks the canonical
event ingested once globally — but matching fans out to every enabled loop in the SAME ingest call, so a
loop is never swallowed by the global mark. Per-destination dedup is the `loop_runs` UNIQUE index.
`X-GitHub-Delivery` ids dedup webhook replays at the route (`delivery:<id>` marks), distinct from the
event canonical key.

## 2. Permission model

- **Tool presence is the first boundary**: `LoopGithubToolsExt` is added to a run's agent only when
  `capabilities.github` has ≥1 switch on. The tools are registered `deferred: true`, so installing the
  extension in `productionExtensions` does not offer them to routine sessions (no `tool_search` exists to
  load them); a github-capable run offers them explicitly via `modelTools.add`.
- **Every write needs human approval**: all tool names start `send_` → matched by the global
  `tarsbot.approval` wildcard `send_*`. Phase 2 has no autoApprove — parked calls hold the run's queue
  slot (known consequence, same as Phase 1's `needs_approval` placeholder).
- **Server-side recheck**: each tool re-reads the persisted loop capabilities + `scopeToTrigger` +
  the bound repo at execute time — capability off → hard error; off-scope entity → `REFUSED` result
  (visible to the model, no GitHub call).
- **Shell bypass closed for loop sessions only**: `LoopApproval` (`tarsbot.loops.approval`) is a second
  approval hook with the extra `gh pr create|issue create|pr comment|issue comment|pr|issue edit|label|
  pr ready` bash patterns, scoped to conversations whose Bot record carries `loopRun` — routine sessions
  keep exactly the pre-existing rules. The global `DEFAULT_BASH_RULES` still cover `gh api -X POST`,
  `gh api -f`, `curl -X POST`, `gh pr merge/close`, `gh repo edit/delete`, `gh release delete`, plus all
  force/baseline git-push cases.
- **Residual shell gap**: `git push` of the run's own `loops/<slug>/<runId>` branch is intentionally
  allowed (readwrite workflow needs it) — it can only create/update that branch on the bound remote.
  `gh issue edit --add-label`/`gh pr edit --add-label` variants are covered by the `edit` pattern.
  `gh api` GET calls and `git push` to non-baseline non-own refs are still possible with token scope;
  a human approval gate wraps the dangerous subsets listed above. A fully deny-by-default shell would
  need a provider/env seam (Sprites `provider.bash` bakes `GH_TOKEN` into every exec) — flagged for
  Phase 3 rather than worked around here.
- **Token never enters the session env**: all GitHub writes go through the server `github` client inside
  the tool `execute`; the model sees args/results only.

## 3. Matching semantics

- `matchesTrigger` gates on `trigger.kind` (issue events never fire `github_pr` loops and vice versa —
  PR conversation comments count as PR-side via `isPr`), the `events[]` list, and optional
  `filters.{branch,label,author}`.
- **Self-comment guard**: events whose `actor` ends in `[bot]` never trigger `commented` loops.
- **Condition vs one-shot**: `labeled`, `closed`, `assigned`, `merged`, `checks_failed`,
  `checks_passed`, `ready_for_review`, `review_submitted` are condition events — they fire on the
  rising edge via `loop_match_state` (per loop+entityRef). One-shot events (`opened`, `commented`,
  `push`, `review_comment`) fire every time.
- **Canonical keys** (`gh:<key>`) are identical across channels for the same real-world event
  (e.g. `issue.opened:<n>`, `comment.created:<commentId>`, `checksuite:<sha>:<state>[:pr<n>]`,
  `pr.review:<n>:<reviewId>`), so webhook↔poll delivery dedups correctly in either direction.

## 4. Files

- `src/control/store.mjs` — `loopMatchState`, `githubCursor`, `githubDeliveries` primitives;
  `loops.listEnabledGithub()`; `links.ofConversation()`; `loopRuns.update` accepts `payload` patch.
  (Tables `loop_match_state`, `github_event_cursor`, `github_deliveries` already existed in the Phase 1
  migration — this fills in the primitives only.)
- `src/github.mjs` — ported `listEvents`/`normalizeEvent`/`getCommitStatus`/`getCheckRuns` +
  `listIssueTimeline`/`listPullReviews` from the Issue13 read-only reference; new write ops
  `createIssueComment`, `addIssueLabels`, `createIssue`; `listPulls` now carries `headSha`.
- `src/loops/github-events.mjs` — normalize webhook+poll events, `canonicalKey`, `matchesTrigger`,
  `startsMatching`, `ingestGithubEvent`.
- `src/loops/github-webhook.mjs` — `X-Hub-Signature-256` HMAC-SHA256 verify (timing-safe, raw body
  capped at 256KB, read once inside the guard), `TARSBOT_GITHUB_WEBHOOK_SECRET`.
- `src/loops/github-poller.mjs` — durable `loops.github.poll` task (registry singleton
  `LoopGithubPollExt` + `bindGithubPoller`), feed scan + Checks supplement, `github_event_cursor`.
- `src/loops/tools.mjs` — `LoopGithubToolsExt` (deferred tools) + `LoopApproval` hook + `bindLoopGithubTools`.
- `src/loops/index.mjs` — wires ingest/ghLoopsByWorkspace/poller/tool binding; `restore()` also syncs
  the poller.
- `src/loops/runner.mjs` — github trigger context block, `loopRun.entity`, `payload.baseBranch`,
  `extensions.add: [LoopApproval, LoopGithubToolsExt?]`, `modelTools.add` for github-capable runs.
- `src/loops/store.mjs` — github triggers normalize `event`→`events[]` (back-compat) + typed filters.
- `src/routes/loops.mjs` — `POST /api/github/webhook` (machine-auth inside guard) +
  `POST /api/loop-runs/:runId/publish` (draft→publish: execution session in the run's worktree/branch,
  task = confirmed text or the saved `send_task_draft` suggestion).
- `src/runtime.mjs` — installs `LoopGithubPollExt`, `LoopApproval`, `LoopGithubToolsExt`.
- `src/server.mjs`, `src/config.mjs` — `TARSBOT_LOOPS_GH_POLL_SEC` (default 300s).
- `web/` — editor github trigger UI (events chips + label/branch filters), run rows show PR link +
  发布任务 button, `triggerLabel` for events[].

## 5. Explicitly NOT implemented / residual gaps

- **No auto-merge anywhere**: nothing merges PRs or pushes to baselines; `gh pr merge` stays gated by the
  global rules anyway.
- **Issue-loop "publish" seam not shared**: `POST /api/loop-runs/:runId/publish` is a new, loop-specific
  route creating a FRESH worktree/branch from the run's pinnedSha — never reuses the run's dir/branch
  (concurrent writes would clobber). The session carries `publishedFrom` provenance + `worktree` metadata
  for the compose panel, NOT `loopRun` (no inherited permission context). Task verbatim: empty → 400,
  >4000 chars → 400 (no silent truncation).
- **`openPr` runs without the tool**: `send_github_open_pr` now REFUSES until `send_git_push` recorded the
  controlled push (`payload.pushed`) — a `succeeded` run with an unpushed branch means the agent simply
  never asked; the tool path is the only publish route.
- **Repo scoping of loops**: an event fans out only to loops whose workspace repo EXACTLY matches
  `ev.repo` (missing either side = skip); canonical keys carry the repo prefix so cross-repo same-number
  events neither dedup nor cross-trigger.
- **Timeline/review gaps**: the feed lacks `assigned`/`labeled` fine-grained history pre-cursor and
  `review_submitted` transitions are best covered by webhook; on poll-only deployments the first tick sees
  only the newest feed window — `supplemented` marks check-derived events; other misses are not
  synthesized (documented, not hidden).
- **`scopeToTrigger=false` runs**: entity restriction lifts, but approval stays mandatory per call and the
  loop hard-blocks on `gh`/`git push`/`git remote`/`github.com curl|wget` remain (no shell GitHub route).
- **Restart of a run awaiting approval**: approval verdicts are memoized (`api.memo`), an unresolved
  wait re-asks after restart — same semantics as the global hook.
- **Shared-Sprite trust boundary (honest)**: loop sessions run bash inside the workspace's shared Sprite.
  The GH_TOKEN strip is real at the exec-env level (verified: spawn env carries `GH_TOKEN:""`), but the
  Sprite is still one trust domain — the hard claim is "no GitHub remote write path through the session
  bash" (gh/git-remote/github-HTTP blocked at the loop guard), not VM-level isolation.

## 7. Fix round (parent source review) — what changed

- `canonicalKey` now `repo:kind.action:...` with `entityUpdatedAt`/`headSha`+`state`/`commentId`/`reviewId`
  instance discriminators; missing repo → no key → rejected. Both normalizers carry `commentId`, `reviewId`,
  `baseRef`, `labels`, `entityUpdatedAt`, `headSha` from the real payloads (poll `normalizeEvent` in
  src/github.mjs plumbed the same fields — no hand-shaped fixtures).
- Repeat-instance events (`labeled`, `closed`, `reopened`, `assigned`, `unlabeled`, checks) dedup per
  instance (entity updated_at / sha+state), so unlabeled→relabeled and reopened→closed fire again.
- Negative transitions (`unlabeled`, `reopened`) CLEAR loop_match_state — re-arms the condition.
- Filters FAIL CLOSED (`f.branch`/`f.author`/`f.label` absent field = no match) + `enrichEvent` fetches
  getPull/getIssue when the payload lacks filter fields.
- Self-feedback: `send_github_comment` records `produced:<commentId>` deliveries (new `source:'tool'` —
  required one migration relaxing the CHECK on github_deliveries); ingest drops those comment events.
- Capabilities: `queue.enqueue` snapshots `loop.capabilities` into `run.payload.capabilities`; tools read
  the snapshot — editing a loop cannot widen a queued/running run.
- Session bash env seam (real, tested): `createSpritesBash` accepts per-call `env` (advertises
  `supportsEnv`); provider `bash(runtimeId,{env})` overlays it; `setExecResolver` returns a loop-scoped
  runner client over `provider.bash(runtimeId,{env:{GH_TOKEN:""}})` for conversations whose bot carries
  `loopRun` → session bash execs spawn with `GH_TOKEN:""` (values injected at `start`, names-only in
  files; routine sessions untouched).
- `LoopApproval` is now a loop-scoped hard boundary: `gh`, `git push|fetch|pull|remote`,
  github.com `curl|wget` → `{block}` (no approval path) for loop sessions only; `hub` stays
  approval-gated as a fallback write route.
- New `send_git_push` tool: server-side `git -C <run.dir> push -u origin <run.branch>` via runtimeBash —
  fixed repo/branch (regex-locked to `loops/<slug>/<id>`), no force/hooks/config/external, approval via
  `send_*` naming; records `payload.pushed`.
- `send_github_open_pr` requires `payload.pushed`; head/base are run-owned invariants (never args, regardless
  of scopeToTrigger); title/body over-limit → error (no truncation); body gains a clickable run link
  (`<publicUrl>/?loopRun=<id>` — the web app deep-links that session) + triggering-entity trailer; records
  `pr_number` on the run AND writes a `executionResult` `{summary, testsReportedByHuman:null, pull, issue,
  sourceBotId, reportedAt}` artifact on the run's Session so the compose panel/overview render it
  (automated artifact — never marked as human-tested).

## 8. Fix rounds 2-3 — hardened push, ingest atomicity, env strip

- `send_git_push` regex matches REAL generated run ids (`loops/<slug>/run_<hex>` — underscore).
- **Clean-config push (proven, not regex-claimed)**: the token-carrying `git push` NEVER reads the agent's
  worktree `.git`. Three stages: (1) tokenless `git bundle create <ref>` from the worktree (pure object
  dump — no remote/credentials), (2) a FRESH service-owned bare repo `init --bare` + `fetch` (no agent
  config copied), (3) `git push` from THAT clean repo with `GIT_CONFIG_NOSYSTEM=1`,
  `GIT_CONFIG_GLOBAL=/dev/null`, `credential.helper=` reset THEN the server helper (reads `$GH_TOKEN` from
  env, never argv), `core.hooksPath=/dev/null`, `core.askPass=false`, `protocol.version=2`,
  `http.proxy=` cleared, a longest-prefix identity `insteadOf`, and an explicit
  `https://github.com/<ws.repo>.git` remote + exact `refs/heads/<branch>:refs/heads/<branch>` refspec.
  A REAL adversarial test (`test/loops-git-push-adversarial.test.mjs`) poisons a temp repo with a malicious
  credential.helper + pre-push hook + insteadOf, replays the staged commands in a real shell, and proves
  the agent helpers/hooks never execute and the token resolves via the server helper only.
- Ingest ordering is failure-safe: `githubDeliveries.mark` LAST, only after every candidate loop's enqueue
  settled; per-loop `loopMatchState` advances only AFTER that loop's enqueue succeeded. An enqueue failure
  leaves the delivery un-marked → redelivery re-processes; already-enqueued loops dedup via
  `UNIQUE(loop_id,trigger_key)`.
- GH_TOKEN strip is REAL at the assembled provider level (proven by `test/env-seam.test.mjs` full-chain
  test: `provider.bash(runtimeId,{env:{GH_TOKEN:""}})` → spawn env has `GH_TOKEN:""`; normal session keeps
  it). The token is injected at `start` via env names; the model cannot pass `env` through the command
  string. Honest residual: the Sprite stays one trust domain — a hostile process could `env`-read the token
  at runtime; the strip blocks the *shell command* path, not in-process reads — Phase-3 seam needed for a
  harder boundary.
- `GET /api/loop-runs/:runId` exists; the PR body links to the app deep link `?loopRun=<id>` which opens
  that run's Session in the product UI.
- Publish route: fresh `loops/publish/<runId>-<hash>` worktree+branch at pinnedSha; `publishedFrom`
  provenance + `worktree` metadata (compose panel); task ≤4000 verbatim.

## 6. Verification

- `npm test`: 438/439 (1 pre-existing skip) — incl. `test/loops-github.test.mjs` (13),
  `test/loops-github-tools.test.mjs` (9), `test/loops-github-poller.test.mjs` (2),
  `test/loops-publish.test.mjs` (2), `test/env-seam.test.mjs` (1).
- `web`: `tsc --noEmit` clean, vitest 160/160, `vite build` to /tmp OK (never to `web/dist`).
- Not exercised live: real GitHub webhook delivery, real `gh` bypass in a Sprite, approval UX mid-run,
  poller against a real feed, real push/PR open.

## 9. Closeout — event-matrix findings + minimal fixes

- **`unassigned` now clears the `assigned` edge** (was missing from NEGATIVE_EVENTS — an assigned loop never
  re-fired after unassign; proven by a re-arm test).
- **`pull_request_review` action normalized to `review_submitted`** (was `submitted` — never in
  CONDITION_EVENTS, so a `["review_submitted"]` loop's edge check silently didn't apply; now consistent).
- Event matrix verified through REAL webhook payload shapes (issues: opened/labeled/closed/assigned/
  unassigned/commented; PRs: opened/ready_for_review/labeled/merged/checks/review) — cross-channel dedup,
  multi-loop fan-out (no swallowing), cross-repo isolation, fail-closed filters, negative re-arm.
- `capabilities.github` survives create→update→reload (JSON round-trip proven); `links.ofConversation`
  accepts a numeric conversationId (parent's String() fix regression-tested).
- Loop-produced `executionResult` renders in EnvironmentPane via a REAL component render (vitest + jsdom —
  the PR link href and the 未记录 automated-artifact label are asserted from the DOM, not hand-built strings).
