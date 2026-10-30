import { useMemo, useState } from "react";
import type { BotSummary } from "../types";
import { describeError, mapBotsToWorkspaces, repoName, workspacesApi, type Workspace } from "../lib/workspaces";
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
  /** SPIKE-add-session: a session was added to this workspace (the new Bot id is selected by the caller). */
  onSessionAdded?: (workspaceId: string, botId: string) => void;
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

/** In-page name form for a manually added session (SPIKE-add-session). Not a native prompt. */
export function AddSessionDialog({
  workspaceName,
  onCreate,
  onClose,
}: {
  workspaceName: string;
  onCreate: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState("新 Session");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await onCreate(name.trim() || "新 Session");
    } catch (err) {
      setError(describeError(err));
      setSubmitting(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={(e) => e.target === e.currentTarget && !submitting && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-session-title"
        onKeyDown={(e) => e.key === "Escape" && !submitting && onClose()}
        className="w-[24rem] max-w-full rounded-lg border border-line-strong bg-raised p-4 shadow-xl"
      >
        <h2 id="add-session-title" className="text-sm font-semibold text-fg">
          添加 Session
        </h2>
        <p className="mt-0.5 text-xs text-fg-muted">在「{workspaceName}」里新建一个空白会话，使用独立目录，不会自动发送消息。</p>
        <form onSubmit={submit} className="mt-3 space-y-3" aria-label="添加 Session">
          <div>
            <label htmlFor="add-session-name" className="block text-xs font-medium text-fg-muted">
              名称
            </label>
            <input
              id="add-session-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
              className="mt-1 w-full rounded-md border border-line bg-field px-2.5 py-1.5 text-sm text-fg focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
          {error && (
            <p role="alert" className="text-xs text-bad">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} disabled={submitting} className="rounded-md border border-line-strong px-2.5 py-1 text-xs font-medium text-fg-dim hover:bg-hover">
              取消
            </button>
            <button type="submit" disabled={submitting} className="rounded-md bg-brand px-3 py-1 text-xs font-medium text-white hover:brightness-110 disabled:opacity-40">
              {submitting ? "创建中…" : "创建"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

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
  onSessionAdded,
}: BotListProps) {
  const [query, setQuery] = useState("");
  // SPIKE-add-session: one open ⋯ menu at a time; the add dialog is for one workspace.
  const [menuOf, setMenuOf] = useState<string>();
  const [addingTo, setAddingTo] = useState<Workspace>();
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
                const menuOpen = menuOf === w.id;
                return (
                  <li key={w.id} className="relative">
                    {/* The row and its ⋯ menu are siblings: a button cannot hold another button. */}
                    <div className="flex items-start gap-1">
                      <button
                        type="button"
                        onClick={() => onSelectWorkspace(w.id)}
                        aria-current={selected ? "true" : undefined}
                        className={`flex min-w-0 flex-1 flex-col gap-0.5 rounded-[10px] border px-2.5 py-2 text-left ${focusRing} ${
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
                      <button
                        type="button"
                        aria-label="更多操作"
                        title="更多操作"
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                        onClick={() => setMenuOf(menuOpen ? undefined : w.id)}
                        className={`mt-2 flex size-6 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg ${focusRing}`}
                      >
                        <span aria-hidden="true">⋯</span>
                      </button>
                    </div>
                    {menuOpen && (
                      <div role="menu" aria-label={`${w.name} 的更多操作`} className="absolute right-1 top-9 z-10 min-w-28 rounded-md border border-line-strong bg-raised py-1 shadow-xl">
                        <button
                          type="button"
                          role="menuitem"
                          disabled={w.status !== "ready"}
                          onClick={() => {
                            setMenuOf(undefined);
                            setAddingTo(w);
                          }}
                          className="block w-full px-3 py-1.5 text-left text-xs text-fg hover:bg-hover disabled:opacity-40"
                        >
                          添加 Session
                        </button>
                      </div>
                    )}
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
      {addingTo && (
        <AddSessionDialog
          workspaceName={addingTo.name}
          onClose={() => setAddingTo(undefined)}
          onCreate={async (name) => {
            const { session } = await workspacesApi.addSession(addingTo.id, { name });
            setAddingTo(undefined);
            onSessionAdded?.(addingTo.id, session.botId);
          }}
        />
      )}
    </nav>
  );
}
