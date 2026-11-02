// Conversation header (reference `.c-head`): breadcrumb + connection state + actions + panel toggle.
import { UsageBadge } from "../components/UsageBadge";
import { Button } from "../components/ui/button";
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
  /** Issue14: open a Loop's run-history view (the "来自 Loop" backlink). */
  onOpenLoop?: (loopId: string) => void;
  railOpen: boolean;
  panelOpen: boolean;
  onExpandRail: () => void;
  onTogglePanel: () => void;
  onCompact: () => void;
  onReset: () => void;
  /** SPIKE-review-loop: human sets the session's business status. */
  onSetStatus?: (status: SessionStatus) => void;
  /** AMP13-collaboration: copy the ?bot=<id> session deep link. */
  onShare?: () => void;
  /** AMP13-collaboration: share feedback ("已复制链接" / failure) rendered inside the header. */
  shareFeedback?: string;
  /** AMP13-collaboration: browser-notification state and opt-in toggle. */
  notifications?: { supported: boolean; permission: string; enabled: boolean; onToggle: () => void };
}

const hbtn = "text-xs font-medium";

export function SessionHeader({
  bot,
  vm,
  status,
  workspace,
  bots = [],
  onSelectBot,
  onOpenLoop,
  railOpen,
  panelOpen,
  onExpandRail,
  onTogglePanel,
  onCompact,
  onReset,
  onSetStatus,
  onShare,
  shareFeedback,
  notifications,
}: SessionHeaderProps) {
  // This session's own git state: a detached discussion/review pins a commit; an execution session has its own branch.
  // The workspace's feature branch is never used to stand in for these sessions.
  const loop = bot?.issueLoop;
  // A PR review session (SPIKE-review-loop) is a detached worktree pinned at the PR's head SHA — its own record,
  // never issueLoop metadata, so it gets no publish-task button.
  const review = !loop ? bot?.review : undefined;
  // A session added by hand (SPIKE-add-session) is a detached worktree too: its own pinned commit, not the feature branch.
  const added = !loop && !review && bot?.worktree ? bot.worktree : undefined;
  // A Loop-run session (Issue14): loopRun carries the run's own pinned commit and optional own branch — the header
  // shows that state, never the workspace feature branch.
  const loopRunGit = !loop && !review && !added && bot?.loopRun?.pinnedSha ? bot.loopRun : undefined;
  const gitLabel = loop
    ? (loop.branch ? loop.branch : `detached @ ${shortSha(loop.pinnedSha) ?? loop.pinnedSha}`)
    : review
      ? `PR #${review.pr} @ ${shortSha(review.headSha) ?? review.headSha}`
      : added
        ? (added.branch ?? `detached @ ${shortSha(added.pinnedSha) ?? added.pinnedSha}`)
        : loopRunGit
          ? (loopRunGit.branch ? loopRunGit.branch : `detached @ ${shortSha(loopRunGit.pinnedSha) ?? loopRunGit.pinnedSha}`)
          : workspace?.branch;
  const gitTitle = loop
    ? `${loop.branch ? `branch ${loop.branch}` : `detached HEAD`} · pinned ${loop.pinnedSha}`
    : review
      ? `reviewing PR #${review.pr} · detached HEAD · pinned ${review.headSha}`
      : added
        ? `${added.branch ? `branch ${added.branch}` : "detached HEAD"} · pinned ${added.pinnedSha}`
        : loopRunGit
          ? `loop run ${loopRunGit.runId} · ${loopRunGit.branch ? `branch ${loopRunGit.branch}` : "detached HEAD"} · pinned ${loopRunGit.pinnedSha}`
          : workspace?.branch;
  const sourceName = loop?.sourceBotId ? (bots.find((b) => b.id === loop.sourceBotId)?.name ?? loop.sourceBotId) : undefined;
  // Issue14: a session created by a Loop run carries loopRun{loopId,runId}; the header shows a "来自 Loop" backlink.
  const loopRun = bot?.loopRun;
  const sessionStatus = bot ? defaultSessionStatus(bot) : undefined;

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-2 sm:gap-3 sm:px-4">
      {!railOpen && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Expand sidebar"
          title="Expand sidebar"
          onClick={onExpandRail}
          className="shrink-0"
        >
          <Icon name="sidebar" className="size-4" />
        </Button>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-2 text-[13px]">
        {bot && workspace && (
          <>
            <span className="flex size-5 shrink-0 items-center justify-center rounded bg-brand text-[9px] font-bold text-white" aria-hidden="true">
              {(workspace.binding?.provider ?? "ws").slice(0, 2).toUpperCase()}
            </span>
            <span className="min-w-0 max-w-40 shrink truncate text-muted-foreground" title={workspace.repo} data-testid="header-repo">
              {repoName(workspace.repo)}
            </span>
            <span className="flex min-w-0 max-w-44 shrink items-center gap-1 text-muted-foreground" title={gitTitle} data-testid="header-branch">
              <Icon name="branch" className="size-3" />
              <span className="truncate font-mono text-xs">{gitLabel}</span>
            </span>
            <span className="hidden min-w-0 max-w-40 shrink truncate text-muted-foreground/70 md:inline" data-testid="header-env">
              {envName(workspace) ?? "环境未就绪"}
            </span>
            <span className="text-muted-foreground/70" aria-hidden="true">
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
              className="hidden truncate text-left text-[11px] leading-tight text-muted-foreground/70 underline decoration-dotted underline-offset-2 hover:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring sm:block"
            >
              来自讨论：{sourceName}
            </button>
          )}
          {loopRun && !sourceName && (
            <button
              type="button"
              onClick={() => onOpenLoop?.(loopRun.loopId)}
              data-testid="backlink-to-loop"
              title={`Loop ${loopRun.loopId} · 运行 ${loopRun.runId}（v${loopRun.version}）`}
              className="block truncate text-left text-[11px] leading-tight text-muted-foreground/70 underline decoration-dotted underline-offset-2 hover:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              来自 Loop：{loopRun.loopId} · 运行 #{String(loopRun.runId).slice(-6)}
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
            className="shrink-0 rounded-md border border-input bg-transparent px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
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
      {vm.compacting > 0 && <span className="text-xs text-muted-foreground">Compacting…</span>}
      <UsageBadge usage={vm.usage} />
      {/* AMP13-collaboration: the deep link opens this session for any signed-in whitelist member. */}
      {onShare && (
        <Button type="button" variant="outline" size="sm" className={hbtn} disabled={!bot} onClick={onShare} title="复制此会话的深链接（仅已登录白名单成员可打开）">
          <Icon name="copy" className="size-3" />
          <span className="hidden sm:inline">分享</span>
        </Button>
      )}
      {shareFeedback && (
        <span role="status" data-testid="share-feedback" className="shrink-0 text-[11px] text-muted-foreground">
          {shareFeedback}
        </span>
      )}
      {notifications?.supported && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={`${hbtn} ${notifications.permission === "denied" ? "border-destructive/40 text-destructive" : ""}`}
          disabled={!bot || notifications.permission === "denied"}
          aria-pressed={notifications.enabled}
          onClick={notifications.onToggle}
          title={
            notifications.permission === "denied"
              ? "浏览器已拒绝通知权限；需在浏览器设置中允许"
              : notifications.enabled
                ? "会话运行结束时通知（页面需保持打开，不是后台推送）"
                : "开启会话完成通知"
          }
        >
          {notifications.permission === "denied" ? "通知被拒" : notifications.enabled ? "通知开" : "通知"}
        </Button>
      )}
      <Button type="button" variant="outline" size="sm" className={`${hbtn} hidden md:inline-flex`} disabled={!bot || vm.busy} onClick={onCompact}>
        Compact
      </Button>
      <Button type="button" variant="outline" size="sm" className={`${hbtn} hidden md:inline-flex`} disabled={!bot} onClick={onReset}>
        Reset
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Toggle side panel"
        aria-pressed={panelOpen}
        title="Toggle side panel"
        onClick={onTogglePanel}
        className={`shrink-0 ${panelOpen ? "text-foreground" : "text-muted-foreground"}`}
      >
        <Icon name="panelRight" className="size-4" />
      </Button>
    </header>
  );
}
