import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { newRequestId } from "../lib/api";
import { describeError, workspacesApi, type GithubBranch, type GithubRepo, type NewWorkspaceInput, type Workspace } from "../lib/workspaces";
import { MODEL_OPTIONS } from "./BotList";

export interface NewWorkspaceDialogProps {
  onCreated: (ws: Workspace) => void;
  onClose: () => void;
}

const field =
  "w-full rounded-md border border-line-strong bg-field px-2 py-1.5 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";
const label = "mb-1 block text-xs text-fg-muted";

export function NewWorkspaceDialog({ onCreated, onClose }: NewWorkspaceDialogProps) {
  // One requestId per opened dialog: double clicks and retries after a failure all reuse it, so the server
  // creates at most one workspace (docs/M1-PLAN.md §4.8).
  const [requestId] = useState(() => newRequestId());

  const [repos, setRepos] = useState<GithubRepo[]>();
  const [reposError, setReposError] = useState<string>();
  const [filter, setFilter] = useState("");
  const [repo, setRepo] = useState("");
  const [branches, setBranches] = useState<GithubBranch[]>();
  const [branchesError, setBranchesError] = useState<string>();
  const [baseBranch, setBaseBranch] = useState("");
  const [task, setTask] = useState("");
  const [modelId, setModelId] = useState(MODEL_OPTIONS[0]);
  const [installCommand, setInstallCommand] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);

  useEffect(() => filterRef.current?.focus(), []);

  useEffect(() => {
    let alive = true;
    workspacesApi
      .repos()
      .then((list) => {
        if (!alive) return;
        setRepos(list);
        setRepo((cur) => cur || list[0]?.fullName || "");
      })
      .catch((e) => alive && setReposError(describeError(e)));
    return () => {
      alive = false;
    };
  }, []);

  const defaultBranch = useMemo(() => repos?.find((r) => r.fullName === repo)?.defaultBranch ?? "", [repos, repo]);

  useEffect(() => {
    if (!repo) return;
    let alive = true;
    setBranches(undefined);
    setBranchesError(undefined);
    setBaseBranch(defaultBranch);
    workspacesApi
      .branches(repo)
      .then((list) => alive && setBranches(list))
      .catch((e) => alive && setBranchesError(describeError(e)));
    return () => {
      alive = false;
    };
    // Re-run only when the repository changes; defaultBranch is derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo]);

  const q = filter.trim().toLowerCase();
  const visibleRepos = useMemo(() => {
    const all = repos ?? [];
    const hit = q ? all.filter((r) => r.fullName.toLowerCase().includes(q)) : all;
    const selected = all.find((r) => r.fullName === repo);
    return selected && !hit.includes(selected) ? [selected, ...hit] : hit;
  }, [repos, q, repo]);

  const branchNames = useMemo(() => {
    const names = (branches ?? []).map((b) => b.name);
    if (defaultBranch && !names.includes(defaultBranch)) names.unshift(defaultBranch);
    return names;
  }, [branches, defaultBranch]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!repo || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(undefined);
    const input: NewWorkspaceInput = {
      requestId,
      repo,
      ...(baseBranch.trim() ? { baseBranch: baseBranch.trim() } : {}),
      ...(task.trim() ? { task: task.trim() } : {}),
      modelId,
      ...(installCommand.trim() ? { installCommand: installCommand.trim() } : {}),
    };
    try {
      const ws = await workspacesApi.create(input);
      onCreated(ws);
      onClose();
    } catch (err) {
      setError(describeError(err));
      setSubmitting(false);
    } finally {
      inFlight.current = false;
    }
  };

  const noRepos = repos !== undefined && repos.length === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={(e) => e.target === e.currentTarget && !submitting && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-workspace-title"
        onKeyDown={(e) => e.key === "Escape" && !submitting && onClose()}
        className="max-h-full w-[30rem] max-w-full overflow-y-auto rounded-lg border border-line-strong bg-raised p-4 shadow-xl"
      >
        <h2 id="new-workspace-title" className="text-sm font-semibold text-fg">
          新建工作区
        </h2>
        <p className="mt-0.5 text-xs text-fg-muted">选择仓库，准备一台独立的云环境，然后让 Agent 开始工作。</p>

        <form onSubmit={submit} className="mt-3 space-y-3" aria-label="新建工作区">
          <div>
            <label htmlFor="ws-repo-filter" className={label}>
              仓库
            </label>
            <input
              id="ws-repo-filter"
              ref={filterRef}
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="输入以过滤仓库"
              aria-label="过滤仓库"
              disabled={!repos}
              className={`${field} mb-1.5`}
              autoComplete="off"
            />
            <select id="ws-repo" aria-label="仓库" value={repo} onChange={(e) => setRepo(e.target.value)} disabled={!repos || noRepos} className={field}>
              {!repos && !reposError && <option value="">加载仓库…</option>}
              {reposError && <option value="">无法加载仓库</option>}
              {noRepos && <option value="">没有可用仓库</option>}
              {visibleRepos.map((r) => (
                <option key={r.fullName} value={r.fullName}>
                  {r.fullName}
                  {r.private ? "（私有）" : ""}
                </option>
              ))}
            </select>
            {reposError && (
              <p role="alert" className="mt-1 text-xs text-bad">
                无法加载仓库列表：{reposError}
              </p>
            )}
            {noRepos && <p className="mt-1 text-xs text-fg-muted">GitHub 账号下没有可用仓库。</p>}
            {repos && repos.length > 0 && visibleRepos.length <= (repo ? 1 : 0) && q && <p className="mt-1 text-xs text-fg-muted">没有匹配的仓库。</p>}
          </div>

          <div>
            <label htmlFor="ws-branch" className={label}>
              起始分支
            </label>
            {branches && !branchesError ? (
              <select id="ws-branch" value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} className={field}>
                {branchNames.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="ws-branch"
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                disabled={!repo}
                placeholder={branchesError ? "手动输入分支名" : repo ? "加载分支…" : "先选择仓库"}
                className={field}
                autoComplete="off"
              />
            )}
            {branchesError && (
              <p role="alert" className="mt-1 text-xs text-bad">
                无法加载分支列表：{branchesError}。可以手动输入分支名。
              </p>
            )}
          </div>

          <div>
            <label htmlFor="ws-task" className={label}>
              需求
            </label>
            <textarea
              id="ws-task"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              rows={4}
              placeholder="希望 Agent 完成什么？可以描述问题、预期行为与验证方式。"
              className={field}
            />
          </div>

          <div>
            <label htmlFor="ws-model" className={label}>
              模型
            </label>
            <select id="ws-model" value={modelId} onChange={(e) => setModelId(e.target.value)} className={field}>
              {MODEL_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>

          <details className="rounded-md border border-line">
            <summary className="cursor-pointer px-2.5 py-1.5 text-xs text-fg-dim focus-visible:outline-2 focus-visible:outline-accent">展开设置</summary>
            <div className="border-t border-line p-2.5">
              <label htmlFor="ws-install" className={label}>
                安装命令
              </label>
              <input
                id="ws-install"
                value={installCommand}
                onChange={(e) => setInstallCommand(e.target.value)}
                placeholder="例如 npm ci（留空则不安装依赖）"
                className={`${field} font-mono`}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </details>

          {error && (
            <p role="alert" className="break-words text-xs text-bad">
              创建失败：{error}。输入已保留，可以再次提交。
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-md border border-line-strong px-3 py-1.5 text-sm text-fg-dim hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={submitting || !repo}
              className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
            >
              {submitting ? "创建中…" : "创建工作区"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
