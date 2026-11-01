// Delegation panel (AMP13-delegation): delegate an explicit task to a child session on the same
// Sprite in its own worktree, see the parent/child relation and status, open the child, send it
// follow-ups, and explicitly read its result back into this conversation. Child state is never
// inferred from busy/idle — the panel says so next to every live signal.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, request } from "../../lib/api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import type { PanelContext, PanelDefinition } from "../types";

interface DelegationParent {
  botId: string;
  name: string;
  depth: number;
  canDelegate: boolean;
  dir: string;
  workspaceId: string;
  maxChildren: number;
  maxDepth: number;
}

interface DelegationTask {
  id: string;
  task: string;
  state: "creating" | "running" | "read" | "failed";
  createdAt: string;
  base: string | null;
  branch: string | null;
  dir: string | null;
  error: string | null;
  result: { summary: string; truncated: boolean; readAt: string } | null;
  child: { exists: boolean; botId?: string; name?: string; status?: string | null; busy?: boolean | null; queued?: number | null };
}

interface DelegationView {
  parent: DelegationParent;
  tasks: DelegationTask[];
}

const POLL_MS = 10_000;

function liveLabel(task: DelegationTask): string {
  if (task.state === "failed") return "创建失败";
  if (task.state === "creating") return "创建中";
  const busy = task.child.busy;
  if (busy === null || busy === undefined) return "运行状态未取得";
  return busy ? "运行中" : "空闲（≠已完成）";
}

function DelegationBody({ bot }: PanelContext) {
  const [view, setView] = useState<DelegationView>();
  const [error, setError] = useState<string>();
  const [task, setTask] = useState("");
  const [path, setPath] = useState("");
  const [attachments, setAttachments] = useState<{ path: string; size: number }[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [msgFor, setMsgFor] = useState<Record<string, string>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string>();

  const botId = bot?.id;
  const load = useCallback(async () => {
    if (!botId) {
      setView(undefined);
      return;
    }
    try {
      setView(await request<DelegationView>("GET", `/api/bots/${encodeURIComponent(botId)}/delegation`));
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [botId]);

  useEffect(() => {
    setAttachments([]);
    setTask("");
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  if (!bot) return <div className="p-4 text-sm text-muted-foreground">选择一个会话后可委派子任务。</div>;
  if (error && !view) return <div className="p-4 text-sm text-muted-foreground">{error}</div>;
  if (!view) return <div className="p-4 text-sm text-muted-foreground">加载中…</div>;

  const addAttachment = async (e: FormEvent) => {
    e.preventDefault();
    const p = path.trim();
    if (!p || attachments.length >= 8) return;
    setBusyKey("file");
    setError(undefined);
    try {
      const f = await request<{ file: { path: string; size: number } }>("POST", `/api/bots/${encodeURIComponent(bot.id)}/delegation/file`, { path: p });
      if (!attachments.some((a) => a.path === f.file.path)) setAttachments([...attachments, { path: f.file.path, size: f.file.size }]);
      setPath("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusyKey(undefined);
    }
  };

  const delegate = async (e: FormEvent) => {
    e.preventDefault();
    if (!task.trim()) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await request("POST", `/api/bots/${encodeURIComponent(bot.id)}/delegation`, {
        task: task.trim(),
        ...(attachments.length ? { contextPaths: attachments.map((a) => a.path) } : {}),
      });
      setTask("");
      setAttachments([]);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const sendMessage = async (taskId: string) => {
    const text = (msgFor[taskId] ?? "").trim();
    if (!text) return;
    setBusyKey(`msg:${taskId}`);
    setError(undefined);
    try {
      await request("POST", `/api/delegation/${encodeURIComponent(taskId)}/message`, { message: text });
      setMsgFor({ ...msgFor, [taskId]: "" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusyKey(undefined);
    }
  };

  const readResult = async (taskId: string) => {
    setBusyKey(`read:${taskId}`);
    setError(undefined);
    try {
      await request("POST", `/api/delegation/${encodeURIComponent(taskId)}/read`, { ...(note[taskId]?.trim() ? { note: note[taskId].trim() } : {}) });
      setNote({ ...note, [taskId]: "" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusyKey(undefined);
    }
  };

  const atChildLimit = view.tasks.length >= view.parent.maxChildren;

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      <Card size="sm" className="gap-2 text-xs leading-5 text-muted-foreground">
        <div>
          委派会给当前会话创建一个<span className="text-foreground">独立 worktree + 独立会话</span>的子任务（默认 swe-2 / high，同工作区同一
          Sprite），<span className="text-foreground">不复制本会话历史</span>。子任务不 push、不开 PR。
        </div>
        <div>
          结果<span className="text-foreground">不会自动回来</span>：由你显式「读取结果」才会作为消息送回本会话；子会话空闲不等于完成。
        </div>
      </Card>

      {view.parent.canDelegate && !atChildLimit ? (
        <Card size="sm">
          <form onSubmit={delegate} className="flex flex-col gap-2">
          <Textarea
            rows={3}
            placeholder="明确的子任务描述（子会话只看到这段文字和你选的附件）"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            maxLength={4000}
          />
          <div className="flex items-center gap-2">
            <Input
              placeholder={`worktree 内文件路径（可选），如 src/a.ts — 相对 ${view.parent.dir}`}
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
            <Button type="button" variant="outline" size="sm" disabled={busyKey === "file" || !path.trim()} onClick={addAttachment}>
              添加附件
            </Button>
          </div>
          {attachments.length > 0 && (
            <ul className="flex flex-col gap-1">
              {attachments.map((a) => (
                <li key={a.path} className="flex items-center justify-between rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                  <span className="truncate">{a.path}（{a.size} bytes）</span>
                  <Button type="button" variant="ghost" size="xs" onClick={() => setAttachments(attachments.filter((x) => x.path !== a.path))}>
                    移除
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">
              子任务 {view.tasks.length}/{view.parent.maxChildren} · 层级 {view.parent.depth}/{view.parent.maxDepth}
            </span>
            <Button type="submit" size="sm" disabled={submitting || !task.trim()}>
              {submitting ? "创建中…" : "委派子任务"}
            </Button>
          </div>
          </form>
        </Card>
      ) : (
        <Card size="sm" className="text-xs text-muted-foreground">
          {atChildLimit ? `子任务数已达上限（${view.parent.maxChildren}）。` : view.parent.depth >= view.parent.maxDepth ? "本会话已是子任务，不能继续委派（层级上限）。" : "工作区未就绪时不能委派。"}
        </Card>
      )}

      {error && <Alert variant="destructive" className="text-xs">{error}</Alert>}

      <ul className="flex flex-col gap-2">
        {view.tasks.length === 0 && <li className="text-xs text-muted-foreground">还没有委派的子任务。</li>}
        {view.tasks.map((t) => (
          <li key={t.id}>
            <Card size="sm" className="gap-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-sm text-foreground">{t.task}</div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {new Date(t.createdAt).toLocaleString()} · {t.branch ?? "—"} · {t.state === "read" ? "已读取结果" : liveLabel(t)}
                </div>
              </div>
              {t.child.botId && (
                <Button
                  variant="outline"
                  size="sm"
                  render={<a href={`?bot=${encodeURIComponent(t.child.botId)}`} />}
                  title={`打开子会话 ${t.child.name ?? t.child.botId}`}
                >
                  打开子会话
                </Button>
              )}
            </div>
            {t.error && <Alert variant="destructive" className="text-xs">{t.error}</Alert>}
            {t.result && (
              <div className="rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground">
                <div className="mb-0.5">已送回本会话的结果（{new Date(t.result.readAt).toLocaleString()}）：</div>
                <div className="whitespace-pre-wrap break-words">{t.result.summary.slice(0, 500)}{t.result.summary.length > 500 ? "…" : ""}</div>
              </div>
            )}
            {(t.state === "running" || t.state === "read") && t.child.exists && (
              <div className="flex flex-col gap-2">
                <div className="flex gap-2">
                  <Input
                    placeholder="给子会话发跟进消息…"
                    value={msgFor[t.id] ?? ""}
                    onChange={(e) => setMsgFor({ ...msgFor, [t.id]: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void sendMessage(t.id);
                      }
                    }}
                  />
                  <Button type="button" variant="outline" size="sm" disabled={busyKey === `msg:${t.id}` || !(msgFor[t.id] ?? "").trim()} onClick={() => void sendMessage(t.id)}>
                    发送
                  </Button>
                </div>
                <div className="flex gap-2">
                  <Input
                    placeholder="读取结果时的备注（可选）"
                    value={note[t.id] ?? ""}
                    onChange={(e) => setNote({ ...note, [t.id]: e.target.value })}
                  />
                  <Button type="button" size="sm" disabled={busyKey === `read:${t.id}`} onClick={() => void readResult(t.id)}>
                    读取结果送回本会话
                  </Button>
                </div>
              </div>
            )}
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

export const delegationPanel: PanelDefinition = {
  id: "delegation",
  title: "Delegation",
  icon: "fork",
  Component: DelegationBody,
  badge: ({ bot }) => {
    const n = bot?.delegation?.tasks?.length;
    return n ? String(n) : undefined;
  },
};
