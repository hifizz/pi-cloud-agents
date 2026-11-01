import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { newRequestId } from "../lib/api";
import { describeError, workspacesApi, type GithubBranch, type GithubRepo, type NewWorkspaceInput, type Workspace } from "../lib/workspaces";
import { MODEL_OPTIONS } from "./BotList";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";

export interface NewWorkspaceDialogProps {
  onCreated: (ws: Workspace) => void;
  onClose: () => void;
}

// Native <select> stays (ForkDialog precedent): tests drive it with selectOptions.
const selectCls =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30";
const labelCls = "mb-1 block text-xs text-muted-foreground";

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
    <Dialog open onOpenChange={(open) => !open && !submitting && onClose()}>
      <DialogContent aria-labelledby="new-workspace-title" showCloseButton={false} className="max-h-full w-[30rem] overflow-y-auto">
        <DialogTitle id="new-workspace-title" className="text-sm font-semibold">
          新建工作区
        </DialogTitle>
        <DialogDescription className="-mt-2 text-xs">选择仓库，准备一台独立的云环境，然后让 Agent 开始工作。</DialogDescription>

        <form onSubmit={submit} className="space-y-3" aria-label="新建工作区">
          <div>
            <Label htmlFor="ws-repo-filter" className={labelCls}>
              仓库
            </Label>
            <Input
              id="ws-repo-filter"
              ref={filterRef}
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="输入以过滤仓库"
              aria-label="过滤仓库"
              disabled={!repos}
              className="mb-1.5"
              autoComplete="off"
            />
            <select id="ws-repo" aria-label="仓库" value={repo} onChange={(e) => setRepo(e.target.value)} disabled={!repos || noRepos} className={selectCls}>
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
              <p role="alert" className="mt-1 text-xs text-destructive">
                无法加载仓库列表：{reposError}
              </p>
            )}
            {noRepos && <p className="mt-1 text-xs text-muted-foreground">GitHub 账号下没有可用仓库。</p>}
            {repos && repos.length > 0 && visibleRepos.length <= (repo ? 1 : 0) && q && <p className="mt-1 text-xs text-muted-foreground">没有匹配的仓库。</p>}
          </div>

          <div>
            <Label htmlFor="ws-branch" className={labelCls}>
              起始分支
            </Label>
            {branches && !branchesError ? (
              <select id="ws-branch" value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} className={selectCls}>
                {branchNames.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                id="ws-branch"
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                disabled={!repo}
                placeholder={branchesError ? "手动输入分支名" : repo ? "加载分支…" : "先选择仓库"}
                autoComplete="off"
              />
            )}
            {branchesError && (
              <p role="alert" className="mt-1 text-xs text-destructive">
                无法加载分支列表：{branchesError}。可以手动输入分支名。
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="ws-task" className={labelCls}>
              需求
            </Label>
            <Textarea
              id="ws-task"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              rows={4}
              placeholder="希望 Agent 完成什么？可以描述问题、预期行为与验证方式。"
            />
          </div>

          <div>
            <Label htmlFor="ws-model" className={labelCls}>
              模型
            </Label>
            <select id="ws-model" value={modelId} onChange={(e) => setModelId(e.target.value)} className={selectCls}>
              {MODEL_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>

          <details className="rounded-md border border-border">
            <summary className="cursor-pointer px-2.5 py-1.5 text-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">展开设置</summary>
            <div className="border-t border-border p-2.5">
              <Label htmlFor="ws-install" className={labelCls}>
                安装命令
              </Label>
              <Input
                id="ws-install"
                value={installCommand}
                onChange={(e) => setInstallCommand(e.target.value)}
                placeholder="例如 npm ci（留空则不安装依赖）"
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </details>

          {error && (
            <p role="alert" className="break-words text-xs text-destructive">
              创建失败：{error}。输入已保留，可以再次提交。
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              取消
            </Button>
            <Button type="submit" disabled={submitting || !repo}>
              {submitting ? "创建中…" : "创建工作区"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
