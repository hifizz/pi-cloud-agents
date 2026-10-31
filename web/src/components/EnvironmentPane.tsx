import { useContext, useEffect, useState } from "react";
import { WorkspaceContext, describeError, envName, modelLabel, shortSha, workspacesApi, type Workspace } from "../lib/workspaces";
import type { BotSummary, ConversationVM } from "../types";
import { WorkspaceActions, WorkspaceStatus } from "./WorkspaceStatus";

export interface EnvironmentPaneProps {
  /** Defaults to the selected workspace published through WorkspaceContext by the App. */
  workspace?: Workspace;
  loading?: boolean;
  onUpdate?: (ws: Workspace) => void;
  onChanged?: () => void;
  bot?: BotSummary;
  vm?: Pick<ConversationVM, "agent">;
  /** Called after a result is reported so the App can refetch the Bot list. */
  onResultReported?: () => void;
}

/** Small human-reported result form for an execution session (SPIKE-review-loop). Tests are labelled as
 * human-entered text, never auto pass/fail; the optional PR number is verified server-side against the bound repo. */
function ResultForm({ workspaceId, botId, onReported, onCancel }: {
  workspaceId: string;
  botId: string;
  onReported: () => void;
  onCancel: () => void;
}) {
  const [summary, setSummary] = useState("");
  const [tests, setTests] = useState("");
  const [pr, setPr] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !summary.trim()) return;
    const prNumber = pr.trim() ? Number(pr.trim()) : undefined;
    if (pr.trim() && (!Number.isInteger(prNumber) || (prNumber ?? 0) <= 0)) {
      setError("PR 编号必须是正整数");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await workspacesApi.reportResult(workspaceId, botId, {
        summary: summary.trim(),
        tests: tests.trim() || undefined,
        pr: prNumber,
      });
      onReported();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };
  return (
    <form aria-label="执行结果" onSubmit={submit} className="space-y-2 rounded-lg border border-line bg-raised p-4">
      <p className="text-xs font-medium text-fg">填写执行结果（人工填写，回流到来源 Issue 的总览卡片）</p>
      <div>
        <label htmlFor="result-summary" className="block text-xs text-fg-muted">
          结果摘要
        </label>
        <textarea
          id="result-summary"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={3}
          className="mt-1 w-full resize-y rounded-md border border-line bg-field px-2.5 py-1.5 text-sm text-fg placeholder:text-fg-faint focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>
      <div>
        <label htmlFor="result-tests" className="block text-xs text-fg-muted">
          测试记录 <span className="text-fg-faint">（人工填写文本，不代表自动通过）</span>
        </label>
        <textarea
          id="result-tests"
          value={tests}
          onChange={(e) => setTests(e.target.value)}
          rows={2}
          className="mt-1 w-full resize-y rounded-md border border-line bg-field px-2.5 py-1.5 text-sm text-fg placeholder:text-fg-faint focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>
      <div>
        <label htmlFor="result-pr" className="block text-xs text-fg-muted">
          PR 编号 <span className="text-fg-faint">（可选，仅本空间仓库的真实 PR）</span>
        </label>
        <input
          id="result-pr"
          type="text"
          inputMode="numeric"
          value={pr}
          onChange={(e) => setPr(e.target.value)}
          className="mt-1 w-32 rounded-md border border-line bg-field px-2.5 py-1.5 text-sm text-fg focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>
      {error && (
        <p role="alert" className="text-xs text-bad">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className="rounded-md border border-line-strong px-2.5 py-1 text-xs font-medium text-fg-dim hover:bg-hover">
          取消
        </button>
        <button type="submit" disabled={busy || !summary.trim()} className="rounded-md bg-brand px-3 py-1 text-xs font-medium text-white hover:brightness-110 disabled:opacity-40">
          {busy ? "提交中…" : "提交结果"}
        </button>
      </div>
    </form>
  );
}

const code = "rounded bg-[#1a1a1a] px-1.5 py-0.5 font-mono text-xs text-fg";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="min-w-0 break-all text-fg">{children}</dd>
    </>
  );
}

export function EnvironmentPane(props: EnvironmentPaneProps) {
  const ctx = useContext(WorkspaceContext);
  const workspace = props.workspace ?? ctx?.workspace;
  const loading = props.loading ?? ctx?.loading ?? false;
  const onUpdate = props.onUpdate ?? ctx?.onUpdate;
  const onChanged = props.onChanged ?? ctx?.onChanged;
  const { bot, vm } = props;
  const [resultFormOpen, setResultFormOpen] = useState(false);
  const onResultReported = props.onResultReported ?? ctx?.onChanged;

  // The panel is not keyed by bot: switching sessions while the result form is open must drop the draft —
  // otherwise a summary typed for execution A posts to execution B's /result endpoint (cross-session result).
  const botId = bot?.id;
  useEffect(() => {
    setResultFormOpen(false);
  }, [botId]);

  if (!workspace) {
    return <p className="p-4 text-sm text-fg-muted">{loading ? "加载中…" : "还没有工作区。新建一个工作区后，这里会显示它的环境信息。"}</p>;
  }

  const agent = vm?.agent;
  const model = agent?.modelId ?? bot?.model.modelId ?? modelLabel(workspace.model);
  const env = envName(workspace);
  const baseSha = shortSha(workspace.baseCommit);
  // Issue-loop sessions and sessions added by hand (SPIKE-add-session) run in their own worktree: show THEIR git state,
  // never the workspace feature branch. PR review sessions (SPIKE-review-loop) are detached at the PR head SHA.
  const loop = bot?.issueLoop;
  const review = !loop ? bot?.review : undefined;
  // A worktree of its own: an issue-loop session, a review session, a session added by hand, or a Loop-run session
  // (Issue14: loopRun carries its own dir/pinnedSha/branch — never fall back to the workspace cwd for it).
  const loopRun = !loop && !review && bot?.loopRun?.dir ? bot.loopRun : undefined;
  const own = loop ?? (review ? { dir: review.dir, pinnedSha: review.headSha, branch: undefined } : undefined) ?? (bot?.worktree ? { dir: bot.worktree.dir, pinnedSha: bot.worktree.pinnedSha, branch: bot.worktree.branch } : undefined) ?? (loopRun ? { dir: loopRun.dir!, pinnedSha: loopRun.pinnedSha, branch: loopRun.branch ?? undefined } : undefined);
  // An execution session (has a source discussion Bot) can report its result back to the source issue.
  const isExecution = Boolean(loop?.sourceBotId);
  const result = bot?.executionResult;

  return (
    <div className="space-y-4 p-4">
      <dl
        className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 rounded-lg border border-line bg-raised p-4 text-sm"
        data-testid="sprite-card"
        data-sandbox={workspace.binding?.provider ?? ""}
      >
        <Row label="工作区">{workspace.name}</Row>
        <Row label="仓库">
          <code className={code}>{workspace.repo}</code>
        </Row>
        <Row label="基准分支">
          <code className={code}>{workspace.baseBranch}</code>
          {baseSha && (
            <>
              {" "}
              <span className="text-fg-muted">@</span> <code className={code}>{baseSha}</code>
            </>
          )}
        </Row>
        {own ? (
          <>
            <Row label="会话目录">
              <code className={code}>{own.dir}</code>
            </Row>
            <Row label="Git 状态">
              {own.branch ? (
                <code className={code}>{own.branch}</code>
              ) : (
                <span>
                  <code className={code}>detached @ {shortSha(own.pinnedSha) ?? own.pinnedSha}</code>
                  <span className="ml-2 text-xs text-fg-muted">无功能分支</span>
                </span>
              )}
            </Row>
          </>
        ) : (
          <Row label="工作分支">
            <code className={code}>{workspace.branch}</code>
          </Row>
        )}
        <Row label="执行环境">
          {env ? (
            <>
              <code className={code}>{env}</code>
              {workspace.binding && <span className="ml-2 text-xs text-fg-muted">绑定版本 v{workspace.binding.version}</span>}
            </>
          ) : (
            <span className="text-fg-muted">尚未绑定</span>
          )}
        </Row>
        {model && (
          <Row label="模型">
            <code className={code}>{model}</code>
          </Row>
        )}
        {agent?.thinkingLevel && <Row label="Thinking">{agent.thinkingLevel}</Row>}
      </dl>

      {workspace.status !== "ready" && <WorkspaceStatus workspace={workspace} onUpdate={onUpdate} />}

      {/* SPIKE-review-loop: an execution session reports its human-written result; it feeds the source issue's
          overview card via the Bot record (aggregated by the parent from the session list). */}
      {bot && (isExecution || (bot.loopRun && result)) && (
        <section aria-label="执行结果" className="space-y-2">
          {result ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-lg border border-line bg-raised p-4 text-sm" data-testid="execution-result">
              <Row label="结果摘要">{result.summary}</Row>
              <Row label="测试记录">
                {result.testsReportedByHuman ? (
                  <span>
                    {result.testsReportedByHuman} <span className="text-xs text-fg-muted">（人工填写）</span>
                  </span>
                ) : (
                  <span className="text-fg-muted">未记录</span>
                )}
              </Row>
              {result.pull && (
                <Row label="关联 PR">
                  <a className="text-accent underline" href={result.pull.url} target="_blank" rel="noreferrer">
                    #{result.pull.number} {result.pull.title}
                  </a>
                  {result.pull.state && <span className="ml-2 text-xs text-fg-muted">{result.pull.state}</span>}
                </Row>
              )}
              <Row label="上报于">{result.reportedAt}</Row>
            </dl>
          ) : resultFormOpen ? (
            <ResultForm
              key={bot.id}
              workspaceId={workspace.id}
              botId={bot.id}
              onReported={() => {
                setResultFormOpen(false);
                onResultReported?.();
              }}
              onCancel={() => setResultFormOpen(false)}
            />
          ) : (
            <button
              type="button"
              data-testid="open-result-form"
              onClick={() => setResultFormOpen(true)}
              className="rounded-md border border-line-strong px-2.5 py-1 text-xs font-medium text-fg-dim hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
            >
              填写执行结果
            </button>
          )}
        </section>
      )}
      {/* keyed: PR result, checkpoint list, request ids and dialogs are per workspace and must not leak to the next one.
          Issue-loop sessions are hidden: those workspace actions act on the old branch and main directory, not on this
          session’s own worktree (issue-loop spike: not extended, not offered). */}
      {!own && <WorkspaceActions key={workspace.id} workspace={workspace} onChanged={onChanged} />}
    </div>
  );
}
