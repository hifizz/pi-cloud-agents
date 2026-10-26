// Workspace preparation status: the five setup steps, the failure reason, and the retry button.
// `variant="full"` is the step list; `variant="banner"` is the one-line notice shown above a disabled composer.
import { useCallback, useEffect, useRef, useState } from "react";
import { newRequestId } from "../lib/api";
import { cx } from "../lib/cx";
import {
  STATUS_LABEL,
  STEP_LABEL,
  STEP_STATE_LABEL,
  currentStep,
  describeError,
  formatBytes,
  formatTime,
  needsRetry,
  orderedSteps,
  workspacesApi,
  type CheckpointManifest,
  type PullInfo,
  type StepState,
  type Workspace,
  type WorkspaceState,
} from "../lib/workspaces";
import { Icon } from "./Chat/primitives/Icon";

const DOT: Record<WorkspaceState, string> = {
  preparing: "animate-pulse bg-warn",
  ready: "bg-ok",
  failed: "bg-bad",
  archived: "bg-fg-faint",
};

/** Status dot with an accessible name ("准备中" / "就绪" / "失败"). */
export function StatusDot({ status, className }: { status: WorkspaceState; className?: string }) {
  return <span role="img" aria-label={STATUS_LABEL[status]} title={STATUS_LABEL[status]} className={cx("inline-block size-2 shrink-0 rounded-full", DOT[status], className)} />;
}

function StepIcon({ state }: { state: StepState }) {
  if (state === "done") return <Icon name="check" className="size-3.5 text-ok" />;
  if (state === "failed") return <Icon name="alert" className="size-3.5 text-bad" />;
  if (state === "unknown") return <Icon name="alert" className="size-3.5 text-warn" />;
  if (state === "running") return <span aria-hidden="true" className="m-[3px] size-2 animate-pulse rounded-full bg-accent" />;
  return <span aria-hidden="true" className="m-[3px] size-2 rounded-full border border-fg-faint" />;
}

const STATE_TEXT: Record<StepState, string> = {
  pending: "text-fg-faint",
  running: "text-accent",
  done: "text-fg-dim",
  failed: "text-bad",
  unknown: "text-warn",
};

const retryButton =
  "shrink-0 rounded-md border border-line-strong px-2.5 py-1 text-xs font-medium text-fg-dim hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40";

export interface WorkspaceStatusProps {
  workspace: Workspace;
  /** Receives the workspace returned by POST /api/workspaces/:id/retry. */
  onUpdate?: (ws: Workspace) => void;
  variant?: "full" | "banner";
}

export function WorkspaceStatus({ workspace, onUpdate, variant = "full" }: WorkspaceStatusProps) {
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string>();

  const retry = async () => {
    setRetrying(true);
    setRetryError(undefined);
    try {
      const next = await workspacesApi.retry(workspace.id);
      onUpdate?.(next);
    } catch (e) {
      setRetryError(describeError(e));
    } finally {
      setRetrying(false);
    }
  };

  const canRetry = needsRetry(workspace);
  const steps = orderedSteps(workspace);
  const current = currentStep(workspace);
  const failedStep = steps.find((s) => s.state === "failed" || s.state === "unknown");
  const reason = workspace.error || failedStep?.error || undefined;
  const retryNode = canRetry && (
    <button type="button" onClick={() => void retry()} disabled={retrying} className={retryButton}>
      {retrying ? "重试中…" : "重试"}
    </button>
  );
  const retryErrorNode = retryError && (
    <p role="alert" className="text-xs text-bad">
      重试失败：{retryError}
    </p>
  );

  if (variant === "banner") {
    if (workspace.status === "ready") return null;
    let text: string;
    let tone: "status" | "alert" = "status";
    if (workspace.status === "archived") {
      text = "工作区已归档，无法继续发送消息。";
    } else if (current?.state === "unknown") {
      text = `工作区准备中断：「${STEP_LABEL[current.step]}」结果待确认。确认后才能继续，输入框暂时禁用。`;
      tone = "alert";
    } else if (workspace.status === "failed" || current?.state === "failed") {
      text = `工作区准备失败：${reason ?? "原因未知"}。输入框已禁用。`;
      tone = "alert";
    } else {
      const label = current ? `${STEP_LABEL[current.step]}（${STEP_STATE_LABEL[current.state]}）` : "排队中";
      text = `正在准备工作区：${label}。就绪后即可发送消息，输入框暂时禁用。`;
    }
    return (
      <div className="mx-auto w-full max-w-[720px] px-[18px] pt-2">
        <div className="flex items-start gap-3 rounded-lg border border-line-strong bg-raised px-3 py-2 text-xs">
          <p role={tone} className={cx("min-w-0 flex-1 break-words", tone === "alert" ? "text-warn" : "text-fg-dim")}>
            {text}
          </p>
          {retryNode}
        </div>
        {retryError && <div className="mt-1">{retryErrorNode}</div>}
      </div>
    );
  }

  return (
    <section aria-label="工作区状态" className="rounded-lg border border-line bg-raised p-4 text-sm">
      <div className="flex items-center gap-2">
        <StatusDot status={workspace.status} />
        <h2 className="min-w-0 flex-1 text-sm font-semibold text-fg">
          {workspace.status === "ready" ? "工作区已就绪" : workspace.status === "failed" ? "工作区准备失败" : workspace.status === "archived" ? "工作区已归档" : "正在准备工作区"}
        </h2>
        {retryNode}
      </div>
      <ol className="mt-3 space-y-2">
        {steps.map((s) => (
          <li key={s.step} data-step={s.step} data-state={s.state} className="flex items-start gap-2">
            <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
              <StepIcon state={s.state} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13px] text-fg">{STEP_LABEL[s.step]}</span>
                <span className={cx("shrink-0 text-xs", STATE_TEXT[s.state])}>{STEP_STATE_LABEL[s.state]}</span>
              </div>
              {s.error && (s.state === "failed" || s.state === "unknown") && <p className="mt-0.5 break-words text-xs text-fg-muted">{s.error}</p>}
            </div>
          </li>
        ))}
      </ol>
      {workspace.error && workspace.error !== failedStep?.error && (
        <p role="alert" className="mt-3 break-words text-xs text-bad">
          {workspace.error}
        </p>
      )}
      {current?.state === "unknown" && <p className="mt-3 text-xs text-fg-muted">无法确认这一步是否已经执行。点击「重试」会先核对现状，再决定是否继续。</p>}
      {retryError && <div className="mt-2">{retryErrorNode}</div>}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Operations on a ready workspace: create PR, save checkpoint, checkpoint list, rebuild from a checkpoint.

const actionBtn =
  "rounded-md border border-line-strong px-2.5 py-1.5 text-xs font-medium text-fg-dim hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40";

function RebuildConfirm({
  checkpoint,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  checkpoint: CheckpointManifest;
  busy: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="rebuild-title"
        onKeyDown={(e) => e.key === "Escape" && !busy && onCancel()}
        className="w-96 max-w-full rounded-lg border border-line-strong bg-raised p-4 shadow-xl"
      >
        <h2 id="rebuild-title" className="text-sm font-semibold text-fg">
          从检查点重建环境
        </h2>
        <p className="mt-2 text-xs text-fg-dim">
          会新建一台环境并恢复到该检查点（{formatTime(checkpoint.createdAt) || "时间未知"} · {formatBytes(checkpoint.size)}）。旧环境不会被删除，但新环境只包含该检查点的内容：比它更新的提交和未保存改动都不会出现在新环境里，只留在旧环境中。
        </p>
        {error && (
          <p role="alert" className="mt-2 break-words text-xs text-bad">
            重建失败：{error}
          </p>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className={actionBtn}>
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-white hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
          >
            {busy ? "重建中…" : error ? "重试重建" : "确认重建"}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface WorkspaceActionsProps {
  workspace: Workspace;
  /** Called after an operation changed server state the parent should refetch (a rebuild changes the binding). */
  onChanged?: () => void;
}

export function WorkspaceActions({ workspace, onChanged }: WorkspaceActionsProps) {
  const id = workspace.id;
  const ready = workspace.status === "ready";

  // Request ids live in refs: they are generated by the first click and reused by failure retries only.
  const prRequestId = useRef<string | undefined>(undefined);
  const [prBusy, setPrBusy] = useState(false);
  const [pr, setPr] = useState<{ pull: PullInfo; created: boolean }>();
  const [prError, setPrError] = useState<string>();

  const [checkpoints, setCheckpoints] = useState<CheckpointManifest[]>();
  const [listError, setListError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<CheckpointManifest>();
  const [saveError, setSaveError] = useState<string>();

  const [rebuildTarget, setRebuildTarget] = useState<CheckpointManifest>();
  const rebuildRequestId = useRef<string | undefined>(undefined);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildError, setRebuildError] = useState<string>();
  const [rebuilt, setRebuilt] = useState<{ replaced?: string }>();

  const loadCheckpoints = useCallback(async () => {
    try {
      setCheckpoints(await workspacesApi.checkpoints(id));
      setListError(undefined);
    } catch (e) {
      setListError(describeError(e));
    }
  }, [id]);

  useEffect(() => {
    if (!ready) return;
    void loadCheckpoints();
  }, [ready, loadCheckpoints]);

  if (!ready) return null;

  const createPr = async () => {
    if (prBusy) return;
    const requestId = (prRequestId.current ??= newRequestId());
    setPrBusy(true);
    setPrError(undefined);
    try {
      setPr(await workspacesApi.createPr(id, { requestId }));
      prRequestId.current = undefined; // done: the next click is a new request (and reports "已存在")
    } catch (e) {
      setPrError(describeError(e)); // keep requestId so a retry is the same request
    } finally {
      setPrBusy(false);
    }
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      setSaved(await workspacesApi.saveCheckpoint(id));
      await loadCheckpoints();
    } catch (e) {
      setSaveError(describeError(e));
    } finally {
      setSaving(false);
    }
  };

  const openRebuild = (cp: CheckpointManifest) => {
    rebuildRequestId.current = newRequestId();
    setRebuildError(undefined);
    setRebuildTarget(cp);
  };

  const confirmRebuild = async () => {
    if (!rebuildTarget || rebuilding) return;
    setRebuilding(true);
    setRebuildError(undefined);
    try {
      const result = await workspacesApi.rebuild(id, { checkpointId: rebuildTarget.id, requestId: rebuildRequestId.current });
      setRebuildTarget(undefined);
      setRebuilt({ replaced: result?.replaced?.runtimeId });
      onChanged?.();
    } catch (e) {
      setRebuildError(describeError(e));
    } finally {
      setRebuilding(false);
    }
  };

  return (
    <section aria-label="工作区操作" className="space-y-4 text-sm">
      <div>
        <h3 className="text-xs font-medium text-fg-muted">交付</h3>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void createPr()} disabled={prBusy} className={actionBtn}>
            {prBusy ? "创建中…" : "创建 PR"}
          </button>
          {pr && (
            <span role="status" className="min-w-0 break-all text-xs text-fg-dim">
              {pr.created ? "PR 已创建：" : "PR 已存在："}
              <a href={pr.pull.url} target="_blank" rel="noreferrer" className="text-accent underline">
                #{pr.pull.number}
              </a>
            </span>
          )}
        </div>
        {prError && (
          <p role="alert" className="mt-1 break-words text-xs text-bad">
            创建 PR 失败：{prError}。可以再次点击重试。
          </p>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium text-fg-muted">检查点</h3>
          <button type="button" onClick={() => void save()} disabled={saving} className={actionBtn}>
            {saving ? "保存中…" : "保存检查点"}
          </button>
        </div>
        <p className="mt-1 text-xs text-fg-faint">保存未提交的代码，用于在新环境中恢复。被 .gitignore 忽略的文件不包含在内。</p>
        {saved && (
          <p role="status" className="mt-1 text-xs text-fg-dim">
            {saved.unchanged ? "与上一个检查点相同，没有新建：" : "已保存："}
            {formatTime(saved.createdAt) || "刚刚"} · {formatBytes(saved.size)}
          </p>
        )}
        {saved?.warnings && saved.warnings.length > 0 && (
          <ul className="mt-1 list-disc pl-4 text-xs text-warn">
            {saved.warnings.map((w) => (
              <li key={w} className="break-words">
                {w}
              </li>
            ))}
          </ul>
        )}
        {saveError && (
          <p role="alert" className="mt-1 break-words text-xs text-bad">
            保存检查点失败：{saveError}
          </p>
        )}
        {listError && (
          <p role="alert" className="mt-1 text-xs text-bad">
            无法加载检查点列表：{listError}{" "}
            <button type="button" onClick={() => void loadCheckpoints()} className="underline">
              重新加载
            </button>
          </p>
        )}
        {checkpoints && checkpoints.length === 0 && !listError && <p className="mt-2 text-xs text-fg-muted">还没有检查点。</p>}
        {checkpoints && checkpoints.length > 0 && (
          <ul aria-label="检查点列表" className="mt-2 space-y-1">
            {checkpoints.map((cp) => (
              <li key={String(cp.id)} data-testid="checkpoint-item" className="flex items-center gap-2 rounded-md border border-line px-2.5 py-1.5">
                <span className="min-w-0 flex-1 text-xs text-fg-dim">
                  {formatTime(cp.createdAt) || "时间未知"} · {formatBytes(cp.size)}
                  {typeof cp.fileCount === "number" ? ` · ${cp.fileCount} 个文件` : ""}
                  {cp.bindingVersion ? ` · 环境 v${cp.bindingVersion}` : ""}
                </span>
                <button type="button" onClick={() => openRebuild(cp)} className={actionBtn} aria-label={`从 ${formatTime(cp.createdAt) || "该"} 检查点重建`}>
                  重建
                </button>
              </li>
            ))}
          </ul>
        )}
        {rebuilt && (
          <p role="status" className="mt-2 text-xs text-ok">
            已新建环境并恢复到检查点。
            {rebuilt.replaced ? `旧环境 ${rebuilt.replaced} 仍保留，比该检查点更新的内容只在旧环境里。` : ""}
          </p>
        )}
      </div>

      {rebuildTarget && (
        <RebuildConfirm checkpoint={rebuildTarget} busy={rebuilding} error={rebuildError} onConfirm={() => void confirmRebuild()} onCancel={() => setRebuildTarget(undefined)} />
      )}
    </section>
  );
}
