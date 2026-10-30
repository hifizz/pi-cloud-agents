// Conversation header (reference `.c-head`): breadcrumb + connection state + actions + panel toggle.
import { UsageBadge } from "../components/UsageBadge";
import { Icon } from "../components/Chat/primitives/Icon";
import { envName, repoName, shortSha, type Workspace } from "../lib/workspaces";
import { SESSION_STATUS_LABEL, defaultSessionStatus, type BotSummary, type ConversationVM, type SessionStatus, type StreamStatus } from "../types";

const STATUS_ORDER: SessionStatus[] = ["discussing", "awaiting", "executing", "done"];

export interface SessionHeaderProps {
  bot?: BotSummary;
  vm: ConversationVM;
  status: StreamStatus;
  /** Workspace the session belongs to: header shows repo, branch and environment name. */
  workspace?: Workspace;
  /** All bots, to resolve the "来自讨论" backlink label. */
  bots?: BotSummary[];
  /** Open another session (the backlink navigates back to the source discussion). */
  onSelectBot?: (botId: string) => void;
  railOpen: boolean;
  panelOpen: boolean;
  onExpandRail: () => void;
  onTogglePanel: () => void;
  onCompact: () => void;
  onReset: () => void;
  /** SPIKE-review-loop: human sets the session's business status. */
  onSetStatus?: (status: SessionStatus) => void;
}

const hbtn =
  "flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-line-strong px-2.5 text-xs font-medium text-fg-dim hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40 disabled:hover:bg-transparent";

export function SessionHeader({
  bot,
  vm,
  status,
  workspace,
  bots = [],
  onSelectBot,
  railOpen,
  panelOpen,
  onExpandRail,
  onTogglePanel,
  onCompact,
  onReset,
  onSetStatus,
}: SessionHeaderProps) {
  // This session's own git state: a detached discussion/review pins a commit; an execution session has its own branch.
  // The workspace's feature branch is never used to stand in for these sessions.
  const loop = bot?.issueLoop;
  // A PR review session (SPIKE-review-loop) is a detached worktree pinned at the PR's head SHA — its own record,
  // never issueLoop metadata, so it gets no publish-task button.
  const review = !loop ? bot?.review : undefined;
  // A session added by hand (SPIKE-add-session) is a detached worktree too: its own pinned commit, not the feature branch.
  const added = !loop && !review && bot?.worktree ? bot.worktree : undefined;
  const gitLabel = loop
    ? (loop.branch ? loop.branch : `detached @ ${shortSha(loop.pinnedSha) ?? loop.pinnedSha}`)
    : review
      ? `PR #${review.pr} @ ${shortSha(review.headSha) ?? review.headSha}`
      : added
        ? `detached @ ${shortSha(added.pinnedSha) ?? added.pinnedSha}`
        : workspace?.branch;
  const gitTitle = loop
    ? `${loop.branch ? `branch ${loop.branch}` : `detached HEAD`} · pinned ${loop.pinnedSha}`
    : review
      ? `reviewing PR #${review.pr} · detached HEAD · pinned ${review.headSha}`
      : added
        ? `detached HEAD · pinned ${added.pinnedSha}`
        : workspace?.branch;
  const sourceName = loop?.sourceBotId ? (bots.find((b) => b.id === loop.sourceBotId)?.name ?? loop.sourceBotId) : undefined;
  const sessionStatus = bot ? defaultSessionStatus(bot) : undefined;

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4">
      {!railOpen && (
        <button
          type="button"
          aria-label="Expand sidebar"
          title="Expand sidebar"
          onClick={onExpandRail}
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
        >
          <Icon name="sidebar" className="size-4" />
        </button>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-2 text-[13px]">
        {bot && workspace && (
          <>
            <span className="flex size-5 shrink-0 items-center justify-center rounded bg-brand text-[9px] font-bold text-white" aria-hidden="true">
              {(workspace.binding?.provider ?? "ws").slice(0, 2).toUpperCase()}
            </span>
            <span className="min-w-0 max-w-40 shrink truncate text-fg-muted" title={workspace.repo} data-testid="header-repo">
              {repoName(workspace.repo)}
            </span>
            <span className="flex min-w-0 max-w-44 shrink items-center gap-1 text-fg-muted" title={gitTitle} data-testid="header-branch">
              <Icon name="branch" className="size-3" />
              <span className="truncate font-mono text-xs">{gitLabel}</span>
            </span>
            <span className="hidden min-w-0 max-w-40 shrink truncate text-fg-faint md:inline" data-testid="header-env">
              {envName(workspace) ?? "环境未就绪"}
            </span>
            <span className="text-fg-faint" aria-hidden="true">
              /
            </span>
          </>
        )}
        <div className="min-w-0">
          <h1 className="truncate font-semibold leading-tight text-white">{bot ? bot.name : "pi-cloud-agents"}</h1>
          {sourceName && (
            <button
              type="button"
              onClick={() => loop?.sourceBotId && onSelectBot?.(loop.sourceBotId)}
              data-testid="backlink-to-discussion"
              title={`返回讨论会话 ${sourceName}`}
              className="block truncate text-left text-[11px] leading-tight text-fg-faint underline decoration-dotted underline-offset-2 hover:text-fg-muted focus-visible:outline-2 focus-visible:outline-accent"
            >
              来自讨论：{sourceName}
            </button>
          )}
        </div>
        {sessionStatus && (
          <select
            aria-label="会话状态"
            data-testid="session-status"
            title="会话业务状态（人工设置，不由运行状态推断）"
            value={sessionStatus}
            disabled={!onSetStatus}
            onChange={(e) => onSetStatus?.(e.target.value as SessionStatus)}
            className="shrink-0 rounded-md border border-line-strong bg-field px-1.5 py-0.5 text-[11px] text-fg-dim hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
          >
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {SESSION_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        )}
      </div>
      {status !== "open" && bot && (
        <span role="status" className="shrink-0 whitespace-nowrap text-xs text-warn">
          {status === "reconnecting" ? "Reconnecting…" : status === "connecting" ? "Connecting…" : "Disconnected"}
        </span>
      )}
      {vm.compacting > 0 && <span className="text-xs text-fg-muted">Compacting…</span>}
      <UsageBadge usage={vm.usage} />
      <button type="button" className={hbtn} disabled={!bot || vm.busy} onClick={onCompact}>
        Compact
      </button>
      <button type="button" className={hbtn} disabled={!bot} onClick={onReset}>
        Reset
      </button>
      <button
        type="button"
        aria-label="Toggle side panel"
        aria-pressed={panelOpen}
        title="Toggle side panel"
        onClick={onTogglePanel}
        className={`flex size-8 shrink-0 items-center justify-center rounded-lg hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent ${panelOpen ? "text-fg" : "text-fg-muted"}`}
      >
        <Icon name="panelRight" className="size-4" />
      </button>
    </header>
  );
}
