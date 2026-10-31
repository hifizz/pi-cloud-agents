// Git panel (AMP13-git): a read-only view of the real git state inside the selected session's own worktree
// (server-resolved dir: issueLoop/review/worktree dir, else the session cwd, else the workspace cwd). It shows
// staged / unstaged / untracked files with per-file diffs, recent commits with expandable diffs and a pick-a-base
// branch comparison. Pure read: the API only ever runs fixed read-only git subcommands. Changes a bot makes through
// real bash appear on refresh.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../../components/Chat/primitives/Icon";
import { request } from "../../lib/api";
import { cx } from "../../lib/cx";
import { describeError } from "../../lib/workspaces";
import type { PanelContext, PanelDefinition } from "../types";

export interface GitFile {
  path: string;
  status: string;
  kind: "staged" | "unstaged" | "both" | "untracked";
}

export interface GitStatus {
  dir: string;
  head: string;
  branch: string | null;
  files: GitFile[];
  filesTruncated: boolean;
}

export interface GitCommit {
  sha: string;
  short: string;
  author: string;
  email: string;
  at: string;
  subject: string;
  parents: string[];
}

export interface GitRef {
  name: string;
  sha: string;
  kind: "branch" | "remote" | "tag";
}

interface DiffResult {
  diff: string;
  truncated?: boolean;
  symlink?: boolean;
}

interface CompareFile {
  status: string;
  path: string;
}

const enc = encodeURIComponent;
const gitApi = {
  status: (botId: string) => request<GitStatus>("GET", `/api/bots/${enc(botId)}/git/status`),
  diff: (botId: string, scope: string, path?: string) =>
    request<DiffResult>("GET", `/api/bots/${enc(botId)}/git/diff?scope=${scope}${path ? `&path=${enc(path)}` : ""}`),
  log: (botId: string, limit = 50) => request<{ commits: GitCommit[] }>("GET", `/api/bots/${enc(botId)}/git/log?limit=${limit}`),
  commitDiff: (botId: string, sha: string) => request<DiffResult>("GET", `/api/bots/${enc(botId)}/git/commit/${enc(sha)}/diff`),
  refs: (botId: string) => request<{ refs: GitRef[]; truncated: boolean }>("GET", `/api/bots/${enc(botId)}/git/refs`),
  compare: (botId: string, base: string, path?: string, nameStatus = false) =>
    request<{ diff: string; truncated: boolean } | { files: CompareFile[]; truncated: boolean }>(
      "GET",
      `/api/bots/${enc(botId)}/git/compare?base=${enc(base)}${path ? `&path=${enc(path)}` : ""}${nameStatus ? "&nameStatus=1" : ""}`,
    ),
};

/** Parse a unified diff into display lines. Binary/deleted files keep git's own markers. */
type RowKind = "add" | "del" | "ctx" | "hunk" | "meta";
function diffRows(text: string): { kind: RowKind; text: string }[] {
  const rows: { kind: RowKind; text: string }[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) {
      rows.push({ kind: "meta", text: line });
    } else if (line.startsWith("@@")) {
      rows.push({ kind: "hunk", text: line });
    } else if (line.startsWith("+")) {
      rows.push({ kind: "add", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", text: line.slice(1) });
    } else if (line.startsWith("\\")) {
      rows.push({ kind: "meta", text: line });
    } else if (line.startsWith("Binary files") || line.startsWith("GIT binary patch") || line.startsWith("deleted file") || line.startsWith("new file") || line.startsWith("old mode") || line.startsWith("new mode") || line.startsWith("similarity") || line.startsWith("rename ")) {
      rows.push({ kind: "meta", text: line });
    } else {
      rows.push({ kind: "ctx", text: line.startsWith(" ") ? line.slice(1) : line });
    }
  }
  return rows;
}

const ROW_CLS: Record<RowKind, string> = {
  add: "bg-diff-add border-l-2 border-l-ok",
  del: "bg-diff-del border-l-2 border-l-bad",
  ctx: "border-l-2 border-l-transparent",
  hunk: "bg-raised text-fg-muted",
  meta: "text-fg-faint",
};

function DiffBody({ text, wrap, emptyNote }: { text: string; wrap: boolean; emptyNote?: string }) {
  const rows = useMemo(() => diffRows(text), [text]);
  if (!text.trim()) return <p className="px-4 py-3 text-xs text-fg-muted">{emptyNote ?? "（无 diff 内容：空文件或无可显示变更）"}</p>;
  return (
    <div className={cx("py-1 font-mono text-[12.5px] leading-[1.7]", !wrap && "overflow-x-auto")}>
      <div className={cx(!wrap && "w-max min-w-full")}>
        {rows.map((r, i) => (
          <div key={i} className={cx("flex", ROW_CLS[r.kind])} data-kind={r.kind}>
            <span className="w-[18px] shrink-0 select-none text-center text-fg-faint">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}</span>
            <span className={cx("min-w-0 flex-1 pr-3", wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre")}>{r.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const KIND_LABEL: Record<GitFile["kind"], string> = { staged: "已暂存", unstaged: "未暂存", both: "部分暂存", untracked: "未跟踪" };
const KIND_CLS: Record<GitFile["kind"], string> = {
  staged: "text-ok",
  unstaged: "text-fg-dim",
  both: "text-fg-dim",
  untracked: "text-fg-faint",
};

const btn = "flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs hover:bg-hover";
const btnIdle = cx(btn, "border-line text-fg-dim");

/** Status file row: click loads that file's diff in the matching scope. */
function FileRow({ file, active, onPick }: { file: GitFile; active: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onPick}
      className={cx(
        "flex w-full items-center gap-2 border-b border-line px-3 py-1.5 text-left text-xs",
        active ? "bg-selected text-fg" : "text-fg hover:bg-hover",
      )}
    >
      <span className={cx("w-14 shrink-0 font-mono", KIND_CLS[file.kind])}>{KIND_LABEL[file.kind]}</span>
      <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>
        {file.path}
      </span>
      <span className="shrink-0 font-mono text-fg-faint">{file.status.trim()}</span>
    </button>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-fg-muted">{children}</h3>;
}

export function GitPanel({ bot }: PanelContext) {
  const botId = bot?.id;
  const [status, setStatus] = useState<GitStatus>();
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [wrap, setWrap] = useState(false);

  // selection: which diff is on screen
  const [diff, setDiff] = useState<DiffResult>();
  const [diffLabel, setDiffLabel] = useState<string>();
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string>();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [openCommit, setOpenCommit] = useState<string>();

  // compare mode
  const [refs, setRefs] = useState<GitRef[]>();
  const [base, setBase] = useState<string>();
  const [compareFiles, setCompareFiles] = useState<CompareFile[]>();
  const [compareTruncated, setCompareTruncated] = useState(false);

  const loadDiff = useCallback(
    async (label: string, promise: Promise<DiffResult>) => {
      setDiffLabel(label);
      setDiffLoading(true);
      setDiffError(undefined);
      setDiff(undefined);
      try {
        const d = await promise;
        setDiff(d);
      } catch (e) {
        setDiffError(describeError(e));
      } finally {
        setDiffLoading(false);
      }
    },
    [],
  );

  const refresh = useCallback(async () => {
    if (!botId) return;
    setLoading(true);
    setError(undefined);
    try {
      const [s, l, r] = await Promise.all([gitApi.status(botId), gitApi.log(botId), gitApi.refs(botId)]);
      setStatus(s);
      setCommits(l.commits);
      setRefs(r.refs);
      // Keep the on-screen diff honest: re-request the same target so a refresh shows real new state.
      if (selectedPath) {
        const f = s.files.find((x) => x.path === selectedPath);
        if (f) {
          void loadDiff(`${f.path}（${KIND_LABEL[f.kind]}）`, f.kind === "untracked" ? gitApi.diff(botId, "untracked", f.path) : gitApi.diff(botId, "unstaged", f.path));
        } else {
          setSelectedPath(undefined);
          setDiff(undefined);
          setDiffLabel(undefined);
        }
      } else if (openCommit) {
        void loadDiff(openCommit.slice(0, 7), gitApi.commitDiff(botId, openCommit));
      } else if (base) {
        void loadDiff(`${base}…HEAD`, gitApi.compare(botId, base) as Promise<DiffResult>);
      }
    } catch (e) {
      setError(describeError(e));
      setStatus(undefined);
      setCommits([]);
    } finally {
      setLoading(false);
    }
  }, [botId, selectedPath, openCommit, base, loadDiff]);

  // Fresh bot / first render: load status + log.
  useEffect(() => {
    setStatus(undefined);
    setCommits([]);
    setRefs(undefined);
    setBase(undefined);
    setCompareFiles(undefined);
    setDiff(undefined);
    setDiffLabel(undefined);
    setSelectedPath(undefined);
    setOpenCommit(undefined);
    setError(undefined);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId]);

  const pickFile = (f: GitFile) => {
    if (!botId) return;
    setOpenCommit(undefined);
    setSelectedPath(f.path);
    const scope = f.kind === "untracked" ? "untracked" : f.kind === "staged" ? "staged" : "unstaged";
    void loadDiff(`${f.path}（${KIND_LABEL[f.kind]}）`, gitApi.diff(botId, scope, f.path));
  };

  const pickCommit = (sha: string) => {
    if (!botId) return;
    if (openCommit === sha) {
      setOpenCommit(undefined);
      setDiff(undefined);
      setDiffLabel(undefined);
      return;
    }
    setSelectedPath(undefined);
    setOpenCommit(sha);
    void loadDiff(sha.slice(0, 7), gitApi.commitDiff(botId, sha));
  };

  // Refs come down with the status refresh; loadRefs is a manual retry for when that first load failed.
  const loadRefs = useCallback(async () => {
    if (!botId || refs) return;
    try {
      const r = await gitApi.refs(botId);
      setRefs(r.refs);
    } catch {
      // non-fatal: the picker stays empty; the compare select can be retried
    }
  }, [botId, refs]);

  const pickBase = async (name: string) => {
    if (!botId) return;
    setBase(name || undefined);
    setSelectedPath(undefined);
    setOpenCommit(undefined);
    setCompareFiles(undefined);
    if (!name) {
      setDiff(undefined);
      setDiffLabel(undefined);
      return;
    }
    try {
      const r = (await gitApi.compare(botId, name, undefined, true)) as { files: CompareFile[]; truncated: boolean };
      setCompareFiles(r.files);
      setCompareTruncated(r.truncated);
    } catch (e) {
      setDiffError(describeError(e));
      return;
    }
    void loadDiff(`${name}…HEAD`, gitApi.compare(botId, name) as Promise<DiffResult>);
  };

  const pickCompareFile = (path: string) => {
    if (!botId || !base) return;
    setSelectedPath(undefined);
    setOpenCommit(undefined);
    void loadDiff(`${base}…HEAD · ${path}`, gitApi.compare(botId, base, path) as Promise<DiffResult>);
  };

  if (!botId) {
    return <p className="p-4 text-sm text-fg-muted">选择一个会话查看它的 git 状态。</p>;
  }

  const shortHead = status?.head.slice(0, 7);

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex h-[42px] shrink-0 items-center gap-2 border-b border-line px-3 text-xs">
        <Icon name="branch" className="text-fg-muted" />
        <span className="min-w-0 truncate font-mono text-fg" title={status?.dir}>
          {status ? (status.branch ?? `detached @ ${shortHead}`) : loading ? "加载中…" : "git"}
        </span>
        {status && <span className="shrink-0 font-mono text-fg-faint">{status.branch ? `@${shortHead}` : ""}</span>}
        <div className="ml-auto flex items-center gap-2">
          <button type="button" aria-pressed={wrap} onClick={() => setWrap((w) => !w)} className={cx(btn, wrap ? "border-line-strong bg-selected text-fg" : "border-line text-fg-dim")}>
            Wrap
          </button>
          <button type="button" onClick={() => void refresh()} disabled={loading} className={btnIdle}>
            <Icon name="history" />
            {loading ? "刷新中…" : "刷新"}
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="border-b border-line px-4 py-2 text-xs text-bad">
          {error}
        </p>
      )}

      <div className="flex-1 overflow-y-auto">
        {status && (
          <section aria-label="工作区改动">
            <SectionTitle>改动（{status.files.length}）</SectionTitle>
            {status.files.length === 0 && <p className="px-4 py-2 text-xs text-fg-muted">工作区干净，没有改动。</p>}
            {status.files.map((f) => (
              <FileRow key={f.path} file={f} active={selectedPath === f.path} onPick={() => pickFile(f)} />
            ))}
            {status.filesTruncated && <p className="px-4 py-2 text-xs text-fg-muted">文件过多，仅显示前 {status.files.length} 项。</p>}
          </section>
        )}

        <section aria-label="分支比较" className="border-t border-line">
          <div className="flex items-center gap-2 px-3 pb-2 pt-3">
            <SectionTitle>与基线比较</SectionTitle>
            <select
              aria-label="比较基线"
              className="h-6 min-w-0 flex-1 rounded-md border border-line bg-field px-1.5 text-xs text-fg"
              value={base ?? ""}
              onMouseDown={() => void loadRefs()}
              onFocus={() => void loadRefs()}
              onChange={(e) => void pickBase(e.target.value)}
            >
              <option value="">选择 ref…</option>
              {(refs ?? []).map((r) => (
                <option key={r.name} value={r.name}>
                  {r.name}（{r.kind}）
                </option>
              ))}
            </select>
          </div>
          {compareFiles && (
            <div>
              {compareFiles.length === 0 && <p className="px-4 py-2 text-xs text-fg-muted">与 {base} 无差异。</p>}
              {compareFiles.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  onClick={() => pickCompareFile(f.path)}
                  className="flex w-full items-center gap-2 border-b border-line px-3 py-1.5 text-left text-xs text-fg hover:bg-hover"
                >
                  <span className="w-8 shrink-0 font-mono text-fg-faint">{f.status}</span>
                  <span className="min-w-0 flex-1 truncate font-mono" title={f.path}>
                    {f.path}
                  </span>
                </button>
              ))}
              {compareTruncated && <p className="px-4 py-2 text-xs text-fg-muted">文件过多，仅显示前 {compareFiles.length} 项。</p>}
            </div>
          )}
        </section>

        <section aria-label="最近提交" className="border-t border-line">
          <SectionTitle>最近提交（{commits.length}）</SectionTitle>
          {commits.map((c) => (
            <button
              key={c.sha}
              type="button"
              aria-pressed={openCommit === c.sha}
              onClick={() => pickCommit(c.sha)}
              className={cx("flex w-full items-baseline gap-2 border-b border-line px-3 py-1.5 text-left text-xs hover:bg-hover", openCommit === c.sha && "bg-selected")}
            >
              <span className="shrink-0 font-mono text-accent">{c.short}</span>
              <span className="min-w-0 flex-1 truncate text-fg" title={c.subject}>
                {c.subject || "（无标题）"}
              </span>
              <span className="shrink-0 text-fg-faint">{c.author}</span>
            </button>
          ))}
          {status && commits.length === 0 && <p className="px-4 py-2 text-xs text-fg-muted">没有提交记录。</p>}
        </section>
      </div>

      {(diffLabel || diffLoading || diffError) && (
        <div className="flex max-h-[55%] shrink-0 flex-col border-t border-line-strong">
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-raised px-3 text-xs">
            <Icon name="diff" className="text-fg-muted" />
            <span className="min-w-0 flex-1 truncate font-mono text-fg" title={diffLabel}>
              {diffLabel}
            </span>
            {diff?.truncated && <span className="shrink-0 text-fg-muted">已截断</span>}
            <button
              type="button"
              aria-label="关闭 diff"
              onClick={() => {
                setDiff(undefined);
                setDiffLabel(undefined);
                setDiffError(undefined);
                setSelectedPath(undefined);
                setOpenCommit(undefined);
              }}
              className="rounded p-1 text-fg-muted hover:bg-hover hover:text-fg"
            >
              <Icon name="x" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {diffError && (
              <p role="alert" className="px-4 py-3 text-xs text-bad">
                {diffError}
              </p>
            )}
            {diffLoading && <p className="px-4 py-3 text-xs text-fg-muted">加载 diff…</p>}
            {diff?.symlink && <p className="px-4 py-3 text-xs text-fg-muted">符号链接：不读取目标内容。</p>}
            {diff && !diff.symlink && <DiffBody text={diff.diff} wrap={wrap} />}
          </div>
        </div>
      )}
    </div>
  );
}

export const gitPanel: PanelDefinition = {
  id: "git",
  title: "Git",
  icon: "branch",
  Component: GitPanel,
};
