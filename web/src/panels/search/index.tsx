// Cross-session search & explicit reference submit (docs/tasks/AMP13-search.md). One self-contained panel:
// search the workspace's sessions, preview the real stored entry a result points at, pick references explicitly,
// then send the user's own question to the current session through the dedicated reference-submit route — never by
// pasting reference text into the normal composer (the server re-reads and labels the cited entries).
import { useCallback, useMemo, useState } from "react";
import { ApiError, request } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { Empty, EmptyDescription } from "../../components/ui/empty";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import type { BotSummary } from "../../types";
import type { PanelContext, PanelDefinition } from "../types";

interface SearchResult {
  botId: string;
  botName: string;
  entryId: string;
  role: string;
  kind: string;
  snippet: string;
}

interface SearchResponse {
  results: SearchResult[];
  scanned: number;
  truncated: boolean;
  sessionsScanned: number;
}

interface ReferencePreview {
  botId: string;
  botName: string;
  entryId: string;
  role: string;
  kind: string;
  text: string;
}

interface RefKey {
  botId: string;
  entryId: string;
}

const MAX_REFERENCES = 5;

function workspaceIdOf(bot: BotSummary | undefined): string | undefined {
  return bot?.workspaceId;
}

/** Session link for a result: `?bot=` is the app-wide deep-link form (collaboration work owns selection). */
function botLink(botId: string): string {
  return `${window.location.pathname}?bot=${encodeURIComponent(botId)}`;
}

export function SessionSearchPanel({ bot }: PanelContext) {
  const workspaceId = workspaceIdOf(bot);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [data, setData] = useState<SearchResponse | undefined>();

  const [checked, setChecked] = useState<Map<string, RefKey>>(new Map());
  const [preview, setPreview] = useState<Record<string, ReferencePreview>>({});
  const [previewOpen, setPreviewOpen] = useState<Record<string, boolean>>({});

  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState(false);
  const [sentNote, setSentNote] = useState<string | undefined>();

  const refKey = (r: RefKey) => `${r.botId}:${r.entryId}`;

  const search = useCallback(async () => {
    if (!workspaceId) return;
    const query = q.trim();
    if (!query) return;
    setLoading(true);
    setError(undefined);
    setSentNote(undefined);
    try {
      const res = await request<SearchResponse>("GET", `/api/workspaces/${encodeURIComponent(workspaceId)}/search?q=${encodeURIComponent(query)}`);
      setData(res);
      setChecked(new Map());
      setPreview({});
      setPreviewOpen({});
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "搜索失败");
      setData(undefined);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, q]);

  const togglePreview = useCallback(
    async (r: SearchResult) => {
      const key = refKey(r);
      setPreviewOpen((m) => ({ ...m, [key]: !m[key] }));
      if (!preview[key] && workspaceId) {
        try {
          const res = await request<{ reference: ReferencePreview }>(
            "GET",
            `/api/workspaces/${encodeURIComponent(workspaceId)}/search/reference?botId=${encodeURIComponent(r.botId)}&entryId=${encodeURIComponent(r.entryId)}`,
          );
          setPreview((m) => ({ ...m, [key]: res.reference }));
        } catch (e) {
          setError(e instanceof ApiError ? e.message : "引用预览失败");
        }
      }
    },
    [preview, workspaceId],
  );

  const toggleCheck = useCallback((r: SearchResult) => {
    const key = refKey(r);
    setChecked((m) => {
      const next = new Map(m);
      if (next.has(key)) next.delete(key);
      else if (next.size < MAX_REFERENCES) next.set(key, { botId: r.botId, entryId: r.entryId });
      return next;
    });
  }, []);

  const refs = useMemo(() => [...checked.values()], [checked]);

  const send = useCallback(async () => {
    if (!workspaceId || !bot) return;
    const text = question.trim();
    if (!text) return;
    setSending(true);
    setError(undefined);
    setSentNote(undefined);
    try {
      await request<{ submissionId: unknown }>("POST", `/api/workspaces/${encodeURIComponent(workspaceId)}/search/submit`, {
        botId: bot.id,
        text,
        references: refs,
      });
      setQuestion("");
      setChecked(new Map());
      setSentNote(`已发送到 “${bot.name}”，引用 ${refs.length} 条（引用内容已由服务器重新读取，标注为参考资料，不是指令）。`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "发送失败");
    } finally {
      setSending(false);
    }
  }, [workspaceId, bot, question, refs]);

  if (!workspaceId) {
    return (
      <Empty className="h-full">
        <EmptyDescription className="max-w-xs">当前会话不属于任何工作区，无法跨会话搜索。</EmptyDescription>
      </Empty>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border p-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索同工作区所有会话历史…"
            aria-label="搜索同工作区会话"
            className="min-w-0 flex-1 text-[12.5px]"
          />
          <Button
            type="submit"
            size="sm"
            disabled={loading || !q.trim()}
            className="h-8 shrink-0 text-[12.5px]"
          >
            {loading ? "搜索中…" : "搜索"}
          </Button>
        </form>
        {data && (
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            {data.results.length} 条结果 · 扫描 {data.scanned} 条历史（{data.sessionsScanned} 个会话）
            {data.truncated ? " · 已达扫描/结果上限，结果不完整" : ""}
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <p role="alert" className="m-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}
        {sentNote && (
          <p role="status" className="m-3 rounded-lg border border-ok/40 bg-ok/10 px-3 py-2 text-xs text-ok">
            {sentNote}
          </p>
        )}
        {data && data.results.length === 0 && !error && (
          <Empty className="h-full">
            <EmptyDescription className="max-w-xs">没有匹配的历史记录。</EmptyDescription>
          </Empty>
        )}
        <ul className="divide-y divide-border">
          {data?.results.map((r) => {
            const key = refKey(r);
            const open = Boolean(previewOpen[key]);
            return (
              <li key={key} className="px-3 py-2.5">
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    aria-label={`引用 ${r.botName} ${r.entryId}`}
                    checked={checked.has(key)}
                    disabled={!checked.has(key) && refs.length >= MAX_REFERENCES}
                    onChange={() => toggleCheck(r)}
                    className="mt-1 shrink-0 accent-primary"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <a
                        href={botLink(r.botId)}
                        className="max-w-40 truncate text-[12px] font-medium text-primary hover:underline"
                        title={`打开会话 ${r.botName}`}
                      >
                        {r.botName}
                      </a>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{r.role}</span>
                      <span className="text-[10px] text-muted-foreground/70">entry {r.entryId}</span>
                      <button
                        type="button"
                        onClick={() => void togglePreview(r)}
                        aria-expanded={open}
                        className="text-[11px] text-muted-foreground underline hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        {open ? "收起预览" : "预览原文"}
                      </button>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-5 text-muted-foreground">{r.snippet}</p>
                    {open && (
                      <pre className="mt-1.5 max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted p-2.5 text-[11.5px] leading-5 text-muted-foreground">
                        {preview[key]?.text ?? "加载中…"}
                      </pre>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {refs.length > 0 && (
        <div className="border-t border-border p-3">
          <p className="mb-1.5 text-[11px] text-muted-foreground">
            已选 {refs.length}/{MAX_REFERENCES} 条引用 · 将作为参考资料（非指令）发送到当前会话 “{bot?.name ?? "?"}”
          </p>
          <Textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={3}
            placeholder="针对所选引用，输入你的问题…"
            aria-label="针对引用输入问题"
            className="resize-y text-[12.5px]"
          />
          <Button
            type="button"
            size="sm"
            onClick={() => void send()}
            disabled={sending || !question.trim()}
            className="mt-2 h-8 text-[12.5px]"
          >
            {sending ? "发送中…" : `发送问题 + ${refs.length} 条引用`}
          </Button>
        </div>
      )}
    </div>
  );
}

export const searchPanel: PanelDefinition = {
  id: "search",
  title: "Search",
  icon: "search",
  Component: SessionSearchPanel,
};
