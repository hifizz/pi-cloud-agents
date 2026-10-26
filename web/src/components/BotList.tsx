import { useMemo, useState } from "react";
import type { BotSummary } from "../types";
import { mapBotsToWorkspaces, repoName, type Workspace } from "../lib/workspaces";
import { Icon } from "./Chat/primitives/Icon";
import { StatusDot } from "./WorkspaceStatus";

// swe-2 stays first: it is the default model (src/config.mjs).
export const MODEL_OPTIONS = ["swe-2", "glm-5.3-flash", "glm-5.3", "claude-sonnet-5-5", "gpt-5.6-terra"];

export interface BotListProps {
  workspaces: Workspace[];
  bots: BotSummary[];
  selectedWorkspaceId?: string;
  selectedBotId?: string;
  onSelectWorkspace: (id: string) => void;
  onSelectBot: (id: string) => void;
  onNewWorkspace: () => void;
  /** Pending approval count per Bot id; shown as a badge. */
  pendingApprovals?: Record<string, number>;
  /** True until the first workspace list arrived. */
  loading?: boolean;
}

/** Compact age like "5m", "2h", "3d"; undefined when the timestamp is missing or invalid. */
export function relativeTime(value: string | number | undefined, now = Date.now()): string | undefined {
  if (value === undefined) return undefined;
  const t = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(t)) return undefined;
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 86_400 * 30) return `${Math.floor(s / 86_400)}d`;
  return `${Math.floor(s / (86_400 * 30))}mo`;
}

const focusRing = "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

function ApprovalBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span role="status" aria-label={`${count} pending approval${count === 1 ? "" : "s"}`} className="rounded-full bg-warn px-1.5 text-[11px] font-semibold text-black">
      {count}
    </span>
  );
}

/** Left rail: project (repo) → workspace → sessions (Bots). Bots without a workspace are not shown. */
export function BotList({
  workspaces,
  bots,
  selectedWorkspaceId,
  selectedBotId,
  onSelectWorkspace,
  onSelectBot,
  onNewWorkspace,
  pendingApprovals = {},
  loading = false,
}: BotListProps) {
  const [query, setQuery] = useState("");
  const botWorkspace = useMemo(() => mapBotsToWorkspaces(bots, workspaces), [bots, workspaces]);
  const botsOf = useMemo(() => {
    const out = new Map<string, BotSummary[]>();
    for (const b of bots) {
      const wid = botWorkspace.get(b.id);
      if (wid) out.set(wid, [...(out.get(wid) ?? []), b]);
    }
    return out;
  }, [bots, botWorkspace]);

  const visibleWorkspaces = workspaces.filter((w) => w.status !== "archived");
  const q = query.trim().toLowerCase();
  const matches = (w: Workspace) =>
    !q || [w.name, w.repo, w.branch, ...(botsOf.get(w.id) ?? []).map((b) => b.name)].some((t) => t?.toLowerCase().includes(q));
  const filtered = visibleWorkspaces.filter(matches);

  const groups = new Map<string, Workspace[]>();
  for (const w of filtered) groups.set(w.repo, [...(groups.get(w.repo) ?? []), w]);

  return (
    <nav aria-label="Workspaces" className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 px-3 py-2.5">
        <button
          type="button"
          onClick={onNewWorkspace}
          className="flex h-9 w-full items-center gap-2 rounded-lg bg-brand px-3 text-[13px] font-medium text-white hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <Icon name="plus" className="size-3.5" />
          新建工作区
        </button>
        <label className="flex h-8 min-w-0 items-center gap-1.5 rounded-lg border border-line bg-field px-2 text-fg-muted focus-within:border-line-strong">
          <Icon name="search" className="size-3.5" />
          <input
            type="search"
            aria-label="搜索工作区"
            placeholder="搜索工作区"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg placeholder:text-fg-faint focus:outline-none"
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-2 pb-2">
        {loading && visibleWorkspaces.length === 0 && <p className="px-2 py-4 text-sm text-fg-muted">加载中…</p>}
        {!loading && visibleWorkspaces.length === 0 && (
          <p className="px-2 py-4 text-sm text-fg-muted">还没有工作区。点击上方「新建工作区」，选择一个仓库开始。</p>
        )}
        {visibleWorkspaces.length > 0 && filtered.length === 0 && <p className="px-2 py-4 text-sm text-fg-muted">没有匹配的工作区。</p>}

        {[...groups].map(([repo, items]) => (
          <section key={repo} aria-label={`项目 ${repo}`}>
            <h3 className="flex items-center gap-1.5 truncate px-2 pb-1 text-[11.5px] font-medium text-fg-muted" title={repo}>
              <Icon name="folder" className="size-3" />
              <span className="truncate">{repo}</span>
            </h3>
            <ul className="space-y-1">
              {items.map((w) => {
                const selected = w.id === selectedWorkspaceId;
                const sessions = botsOf.get(w.id) ?? [];
                const pendingTotal = sessions.reduce((n, b) => n + (pendingApprovals[b.id] ?? 0), 0);
                const age = relativeTime(w.createdAt);
                return (
                  <li key={w.id}>
                    <button
                      type="button"
                      onClick={() => onSelectWorkspace(w.id)}
                      aria-current={selected ? "true" : undefined}
                      className={`flex w-full flex-col gap-0.5 rounded-[10px] border px-2.5 py-2 text-left ${focusRing} ${
                        selected ? "border-[#262626] bg-selected" : "border-transparent hover:bg-hover"
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <StatusDot status={w.status} />
                        <span className={`min-w-0 flex-1 truncate text-[13px] font-medium ${selected ? "text-white" : "text-fg"}`}>{w.name}</span>
                        {!selected && <ApprovalBadge count={pendingTotal} />}
                        {age && <span className="shrink-0 font-mono text-[11px] text-fg-muted">{age}</span>}
                      </span>
                      <span className="flex min-w-0 items-center gap-1.5 pl-4 text-[11.5px] text-fg-muted">
                        <span className="shrink-0">{repoName(w.repo)}</span>
                        <Icon name="branch" className="size-3" />
                        <span className="truncate font-mono">{w.branch}</span>
                      </span>
                    </button>
                    {selected && sessions.length > 0 && (
                      <ul aria-label={`${w.name} 的会话`} className="mb-1 ml-5 mt-1 space-y-0.5 border-l border-line pl-2">
                        {sessions.map((bot) => {
                          const botSelected = bot.id === selectedBotId;
                          const parentName = bot.parent ? (bots.find((b) => b.id === bot.parent?.botId)?.name ?? "unknown") : undefined;
                          return (
                            <li key={bot.id}>
                              <button
                                type="button"
                                onClick={() => onSelectBot(bot.id)}
                                aria-current={botSelected ? "true" : undefined}
                                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] ${focusRing} ${
                                  botSelected ? "bg-[#161616] text-white" : "text-fg-dim hover:bg-hover"
                                }`}
                              >
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate font-medium">{bot.name}</span>
                                  {(parentName || bot.queued > 0 || bot.readOnly) && (
                                    <span className="block truncate text-[11px] text-fg-muted">
                                      {parentName && <span title={`Forked from ${parentName}`}>↳ {parentName}</span>}
                                      {bot.readOnly && <span>{parentName ? " · 只读" : "只读"}</span>}
                                      {(parentName || bot.readOnly) && bot.queued > 0 && " · "}
                                      {bot.queued > 0 && <span>{bot.queued} queued</span>}
                                    </span>
                                  )}
                                </span>
                                <ApprovalBadge count={pendingApprovals[bot.id] ?? 0} />
                                <span
                                  role="img"
                                  aria-label={bot.busy ? "busy" : "idle"}
                                  className={`size-2 shrink-0 rounded-full ${bot.busy ? "animate-pulse bg-warn" : "bg-fg-faint"}`}
                                />
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </nav>
  );
}
