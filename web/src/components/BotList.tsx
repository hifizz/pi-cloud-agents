import { useMemo, useState } from "react";
import { SESSION_STATUS_LABEL, defaultSessionStatus, type BotSummary } from "../types";
import { describeError, mapBotsToWorkspaces, repoName, workspacesApi, type Workspace } from "../lib/workspaces";
import { Icon } from "./Chat/primitives/Icon";
import { StatusDot } from "./WorkspaceStatus";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";
import { Label } from "./ui/label";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "./ui/sidebar";
import { HugeiconsIcon } from "@hugeicons/react";
import { MoreHorizontalIcon } from "@hugeicons/core-free-icons";

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
    <Dialog open onOpenChange={(open) => !open && !submitting && onClose()}>
      <DialogContent aria-labelledby="add-session-title" showCloseButton={false} className="w-[24rem]">
        <DialogTitle id="add-session-title" className="text-sm font-semibold">
          添加 Session
        </DialogTitle>
        <DialogDescription className="-mt-2 text-xs">
          在「{workspaceName}」里新建一个空白会话，使用独立目录，不会自动发送消息。
        </DialogDescription>
        <form onSubmit={submit} className="space-y-3" aria-label="添加 Session 表单">
          <div>
            <Label htmlFor="add-session-name" className="mb-1.5 block text-xs font-medium text-muted-foreground">
              名称
            </Label>
            <Input id="add-session-name" type="text" value={name} onChange={(e) => setName(e.target.value)} disabled={submitting} />
          </div>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={submitting}>
              取消
            </Button>
            <Button type="submit" size="sm" disabled={submitting}>
              {submitting ? "创建中…" : "创建"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ApprovalBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <Badge
      role="status"
      aria-label={`${count} pending approval${count === 1 ? "" : "s"}`}
      className="rounded-full border-transparent bg-warn px-1.5 text-[11px] font-semibold text-black"
    >
      {count}
    </Badge>
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
  // SPIKE-add-session: the add dialog is for one workspace.
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
      <div className="space-y-2 p-2 pb-0">
        <Button type="button" onClick={onNewWorkspace} size="lg" className="w-full gap-2 text-[13px]">
          <Icon name="plus" className="size-3.5" />
          新建工作区
        </Button>
        <InputGroup>
          <InputGroupAddon>
            <Icon name="search" className="size-3.5" />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            aria-label="搜索工作区"
            placeholder="搜索工作区"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="text-[12.5px]"
          />
        </InputGroup>
      </div>

      <SidebarContent className="gap-3 px-1">
        {loading && visibleWorkspaces.length === 0 && (
          <SidebarMenu aria-hidden="true">
            {Array.from({ length: 3 }, (_, i) => (
              <li key={i} style={{ "--skeleton-width": `${85 - i * 10}%` } as React.CSSProperties}>
                <SidebarMenuSkeleton showIcon />
              </li>
            ))}
          </SidebarMenu>
        )}
        {!loading && visibleWorkspaces.length === 0 && (
          <p className="px-2 py-4 text-sm text-muted-foreground">还没有工作区。点击上方「新建工作区」，选择一个仓库开始。</p>
        )}
        {visibleWorkspaces.length > 0 && filtered.length === 0 && <p className="px-2 py-4 text-sm text-muted-foreground">没有匹配的工作区。</p>}

        {[...groups].map(([repo, items]) => (
          <SidebarGroup key={repo} aria-label={`项目 ${repo}`}>
            <SidebarGroupLabel title={repo}>
              <Icon name="folder" className="size-3" />
              <span className="truncate">{repo}</span>
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {items.map((w) => {
                  const selected = w.id === selectedWorkspaceId;
                  const sessions = botsOf.get(w.id) ?? [];
                  const pendingTotal = sessions.reduce((n, b) => n + (pendingApprovals[b.id] ?? 0), 0);
                  const age = relativeTime(w.createdAt);
                  return (
                    <SidebarMenuItem key={w.id} className="group/menu-item">
                      <SidebarMenuButton
                        isActive={selected}
                        aria-current={selected ? "true" : undefined}
                        onClick={() => onSelectWorkspace(w.id)}
                        className="h-auto py-2"
                      >
                        <StatusDot status={w.status} />
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{w.name}</span>
                            {!selected && <ApprovalBadge count={pendingTotal} />}
                            {age && <span className="shrink-0 font-mono text-[11px] text-sidebar-foreground/50">{age}</span>}
                          </span>
                          <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-sidebar-foreground/60">
                            <span className="shrink-0">{repoName(w.repo)}</span>
                            <Icon name="branch" className="size-3" />
                            <span className="truncate font-mono">{w.branch}</span>
                          </span>
                        </span>
                      </SidebarMenuButton>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <SidebarMenuAction aria-label="更多操作" title="更多操作">
                              <HugeiconsIcon icon={MoreHorizontalIcon} aria-hidden="true" />
                            </SidebarMenuAction>
                          }
                        />
                        <DropdownMenuContent align="start" aria-label={`${w.name} 的更多操作`}>
                          <DropdownMenuItem disabled={w.status !== "ready"} onClick={() => setAddingTo(w)}>
                            添加 Session
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                      {selected && sessions.length > 0 && (
                        <SidebarMenuSub aria-label={`${w.name} 的会话`}>
                          {sessions.map((bot) => {
                            const botSelected = bot.id === selectedBotId;
                            const parentName = bot.parent ? (bots.find((b) => b.id === bot.parent?.botId)?.name ?? "unknown") : undefined;
                            // Business status (human-set; defaults from origin). The busy/idle dot stays as run state.
                            const sessionStatus = defaultSessionStatus(bot);
                            return (
                              <SidebarMenuSubItem key={bot.id}>
                                <SidebarMenuSubButton isActive={botSelected} aria-current={botSelected ? "true" : undefined} onClick={() => onSelectBot(bot.id)}>
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate font-medium" title={bot.name}>
                                      {bot.name}
                                      <span data-testid="session-status-label" className="ml-1.5 text-[11px] font-normal text-sidebar-foreground/60">
                                        {SESSION_STATUS_LABEL[sessionStatus]}
                                      </span>
                                    </span>
                                    {(parentName || bot.queued > 0 || bot.readOnly) && (
                                      <span className="block truncate text-[11px] text-sidebar-foreground/60">
                                        {parentName && <span title={`Forked from ${parentName}`}>↳ {parentName}</span>}
                                        {bot.readOnly && <span>{parentName ? " · 只读" : "只读"}</span>}
                                        {(parentName || bot.readOnly) && bot.queued > 0 && " · "}
                                        {bot.queued > 0 && <span>{bot.queued} queued</span>}
                                      </span>
                                    )}
                                  </span>
                                  <SidebarMenuBadge className="h-auto min-w-0 px-0 text-[11px]">
                                    <ApprovalBadge count={pendingApprovals[bot.id] ?? 0} />
                                  </SidebarMenuBadge>
                                  <span
                                    role="img"
                                    aria-label={bot.busy ? "busy" : "idle"}
                                    className={`size-2 shrink-0 rounded-full ${bot.busy ? "animate-pulse bg-warn" : "bg-muted-foreground"}`}
                                  />
                                </SidebarMenuSubButton>
                              </SidebarMenuSubItem>
                            );
                          })}
                        </SidebarMenuSub>
                      )}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
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
