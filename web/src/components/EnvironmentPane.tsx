import { useCallback, useContext, useEffect, useState } from "react";
import { WorkspaceContext, describeError, envName, modelLabel, shortSha, workspacesApi, type SessionEnvEntry, type Workspace } from "../lib/workspaces";
import type { BotSummary, ConversationVM } from "../types";
import { WorkspaceActions, WorkspaceStatus } from "./WorkspaceStatus";
import { Button } from "./ui/button";
import { Empty, EmptyDescription } from "./ui/empty";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";

export interface EnvironmentPaneProps {
  /** Defaults to the selected workspace published through WorkspaceContext by the App. */
  workspace?: Workspace;
  loading?: boolean;
  onUpdate?: (ws: Workspace) => void;
  onChanged?: () => void;
  bot?: BotSummary;
  vm?: Pick<ConversationVM, "agent">;
  /** Called after a result is reported so the App can refetch the Bot list. */
  onResultReported?: () => void;
}

/** Small human-reported result form for an execution session (SPIKE-review-loop). Tests are labelled as
 * human-entered text, never auto pass/fail; the optional PR number is verified server-side against the bound repo. */
function ResultForm({ workspaceId, botId, onReported, onCancel }: {
  workspaceId: string;
  botId: string;
  onReported: () => void;
  onCancel: () => void;
}) {
  const [summary, setSummary] = useState("");
  const [tests, setTests] = useState("");
  const [pr, setPr] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !summary.trim()) return;
    const prNumber = pr.trim() ? Number(pr.trim()) : undefined;
    if (pr.trim() && (!Number.isInteger(prNumber) || (prNumber ?? 0) <= 0)) {
      setError("PR 编号必须是正整数");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await workspacesApi.reportResult(workspaceId, botId, {
        summary: summary.trim(),
        tests: tests.trim() || undefined,
        pr: prNumber,
      });
      onReported();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };
  return (
    <form aria-label="执行结果" onSubmit={submit} className="space-y-2 rounded-lg border border-border bg-card p-4">
      <p className="text-xs font-medium text-foreground">填写执行结果（人工填写，回流到来源 Issue 的总览卡片）</p>
      <div>
        <Label htmlFor="result-summary" className="text-xs text-muted-foreground">
          结果摘要
        </Label>
        <Textarea
          id="result-summary"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={3}
          className="mt-1 min-h-0 resize-y"
        />
      </div>
      <div>
        <Label htmlFor="result-tests" className="text-xs text-muted-foreground">
          测试记录 <span className="text-muted-foreground/70">（人工填写文本，不代表自动通过）</span>
        </Label>
        <Textarea
          id="result-tests"
          value={tests}
          onChange={(e) => setTests(e.target.value)}
          rows={2}
          className="mt-1 min-h-0 resize-y"
        />
      </div>
      <div>
        <Label htmlFor="result-pr" className="text-xs text-muted-foreground">
          PR 编号 <span className="text-muted-foreground/70">（可选，仅本空间仓库的真实 PR）</span>
        </Label>
        <Input
          id="result-pr"
          type="text"
          inputMode="numeric"
          value={pr}
          onChange={(e) => setPr(e.target.value)}
          className="mt-1 w-32"
        />
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={busy}>
          取消
        </Button>
        <Button type="submit" size="sm" disabled={busy || !summary.trim()}>
          {busy ? "提交中…" : "提交结果"}
        </Button>
      </div>
    </form>
  );
}

const code = "rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground";

// ---------------------------------------------------------------------------------------------------------------------
// ENV-DEMO: workspace env defaults + per-session overrides. Values are write-only — the API never returns
// plaintext; the UI only ever shows names, sources (继承/覆盖/禁用) and masked state.
// ---------------------------------------------------------------------------------------------------------------------

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function EnvRow({ name, detail, actions }: { name: string; detail: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 py-1 text-sm">
      <code className={code}>{name}</code>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{detail}</span>
      {actions}
    </div>
  );
}

/** Workspace-level defaults editor: masked list + set/remove. The same `kind` input handles new vars and edits.
 * `onVarsChanged` lets the parent tell the session panel to re-read its source list (the inherited names an
 * override can act on changed). */
function WorkspaceEnvVars({ workspaceId, onVarsChanged }: { workspaceId: string; onVarsChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  const [vars, setVars] = useState<{ name: string; masked: boolean; updatedAt?: string }[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = useCallback(() => {
    workspacesApi
      .envList(workspaceId)
      .then((r) => {
        setVars(r.vars ?? []);
        setEnabled(r.enabled !== false);
        setLoaded(true);
        setError(undefined);
      })
      .catch((e) => {
        setLoaded(true);
        setError(describeError(e)); // do NOT silently fall back to "enabled / empty list"
      });
  }, [workspaceId]);
  useEffect(() => {
    if (open && !loaded) refresh();
  }, [open, loaded, refresh]);

  if (!open) {
    return (
      <button
        type="button"
        data-testid="open-ws-env"
        onClick={() => setOpen(true)}
        className="w-full rounded-lg border border-border bg-card p-4 text-left text-xs font-medium text-foreground hover:bg-muted"
      >
        工作区环境变量 <span className="font-normal text-muted-foreground">（默认变量，所有普通 Session 继承）</span>
      </button>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!ENV_NAME_RE.test(n)) {
      setError("变量名须为 [A-Za-z_][A-Za-z0-9_]*");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await workspacesApi.envSet(workspaceId, n, value);
      setName("");
      setValue("");
      refresh();
      onVarsChanged?.();
    } catch (err) {
      setError(describeError(err)); // keep the draft: the user did not consent to losing it
    } finally {
      setBusy(false);
    }
  };

  const remove = async (n: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await workspacesApi.envRemove(workspaceId, n);
      refresh();
      onVarsChanged?.();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="工作区环境变量" className="space-y-2 rounded-lg border border-border bg-card p-4" data-testid="ws-env">
      <p className="text-xs font-medium text-foreground">
        工作区环境变量
        <button type="button" onClick={() => setOpen(false)} className="ml-2 font-normal text-muted-foreground hover:text-foreground">
          收起
        </button>
      </p>
      <p className="text-xs text-muted-foreground">
        普通 Session 的新命令与新终端继承这些值（加密保存，值不可回读；仅对新进程生效，已运行的服务需重启）。
        {!enabled && <span className="text-destructive"> 未配置 TARSBOT_ENV_KEY，功能已禁用。</span>}
      </p>
      {!loaded && !error && <p className="text-xs text-muted-foreground">加载中…</p>}
      {vars.map((v) => (
        <EnvRow
          key={v.name}
          name={v.name}
          detail="已设置（值不回显）"
          actions={
            <Button type="button" variant="outline" size="xs" disabled={busy || !enabled} onClick={() => void remove(v.name)}>
              删除
            </Button>
          }
        />
      ))}
      <form onSubmit={submit} className="flex items-center gap-2">
        <Input
          aria-label="变量名"
          placeholder="NAME"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={!enabled}
          className="h-7 w-40 font-mono text-xs"
        />
        <Input
          aria-label="变量值"
          type="password"
          autoComplete="off"
          placeholder="value（不回显，可为空字符串）"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={!enabled}
          className="h-7 min-w-0 flex-1 font-mono text-xs"
        />
        <Button type="submit" size="sm" disabled={busy || !enabled || !name.trim()}>
          {vars.some((v) => v.name === name.trim()) ? "覆盖" : "保存"}
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

const MODE_LABEL: Record<string, string> = { inherit: "继承工作区默认", set: "本 Session 覆盖", disabled: "已禁用（unset）" };

/** Per-session overrides of the selected session: inherit / set / disable / restore. Restricted sessions
 * (loop run, read-only fork) see a read-only note — they never carry user variables. */
function SessionEnvVars({ botId, refreshKey = 0 }: { botId: string; refreshKey?: number }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ enabled: boolean; restricted: boolean; entries: SessionEnvEntry[] }>();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = useCallback(() => {
    workspacesApi
      .sessionEnvList(botId)
      .then((r) => {
        setState({ enabled: r?.enabled !== false, restricted: r?.restricted === true, entries: r?.entries ?? [] });
        setError(undefined);
      })
      .catch((e) => setError(describeError(e))); // keep prior state; do NOT assume enabled/empty
  }, [botId]);
  // remount handled by the parent's `key`; also re-pull the source list when workspace vars change
  useEffect(() => {
    setState(undefined);
    setOpen(false);
  }, [botId]);
  useEffect(() => {
    if (refreshKey > 0 && open) refresh();
  }, [refreshKey, open, refresh]);
  useEffect(() => {
    if (open && !state) refresh();
  }, [open, state, refresh]);

  if (!open) {
    return (
      <button
        type="button"
        data-testid="open-session-env"
        onClick={() => setOpen(true)}
        className="w-full rounded-lg border border-border bg-card p-4 text-left text-xs font-medium text-foreground hover:bg-muted"
      >
        本 Session 环境变量 <span className="font-normal text-muted-foreground">（覆盖 / 禁用 / 恢复继承）</span>
      </button>
    );
  }

  const apply = async (n: string, input: { mode: "set" | "disabled" | "inherit"; value?: string }) => {
    setBusy(true);
    setError(undefined);
    try {
      await workspacesApi.sessionEnvSet(botId, n, input);
      refresh();
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!ENV_NAME_RE.test(n)) {
      setError("变量名须为 [A-Za-z_][A-Za-z0-9_]*");
      return;
    }
    if (await apply(n, { mode: "set", value })) {
      setName("");
      setValue("");
    }
  };

  if (!state) {
    return (
      <section aria-label="Session 环境变量" className="space-y-2 rounded-lg border border-border bg-card p-4">
        <p className="text-xs font-medium text-foreground">本 Session 环境变量</p>
        {error ? (
          <>
            <p role="alert" className="text-xs text-destructive">{error}</p>
            <Button type="button" variant="outline" size="xs" onClick={() => { setError(undefined); refresh(); }}>
              重试
            </Button>
          </>
        ) : <p className="text-xs text-muted-foreground">加载中…</p>}
      </section>
    );
  }

  return (
    <section aria-label="Session 环境变量" className="space-y-2 rounded-lg border border-border bg-card p-4" data-testid="session-env">
      <p className="text-xs font-medium text-foreground">
        本 Session 环境变量
        <button type="button" onClick={() => setOpen(false)} className="ml-2 font-normal text-muted-foreground hover:text-foreground">
          收起
        </button>
      </p>
      <p className="text-xs text-muted-foreground">
        覆盖或禁用只影响本 Session 的新命令/新终端；禁用是 unset，不是空字符串。Loop run 与只读 fork 不获得用户变量。
        {!state.enabled && <span className="text-destructive"> 未配置 TARSBOT_ENV_KEY，功能已禁用。</span>}
      </p>
      {state.restricted ? (
        <p className="text-xs text-muted-foreground">受限 Session（loop run / 只读 fork）：不使用工作区环境变量，也不可配置。</p>
      ) : (
        <>
          {state.entries.length === 0 && <p className="text-xs text-muted-foreground">工作区未设置默认变量。</p>}
          {state.entries.map((en) => (
            <EnvRow
              key={en.name}
              name={en.name}
              detail={MODE_LABEL[en.mode] ?? en.mode}
              actions={
                <span className="flex gap-1">
                  {en.mode !== "disabled" && (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={busy || !state.enabled}
                      onClick={() => void apply(en.name, { mode: "disabled" })}
                    >
                      禁用
                    </Button>
                  )}
                  {en.mode !== "inherit" && (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={busy || !state.enabled}
                      onClick={() => void apply(en.name, { mode: "inherit" })}
                    >
                      {en.mode === "disabled" && !en.inherits ? "移除覆盖" : "恢复继承"}
                    </Button>
                  )}
                </span>
              }
            />
          ))}
          <form onSubmit={submit} className="flex items-center gap-2">
            <Input
              aria-label="覆盖变量名"
              placeholder="NAME"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!state.enabled}
              className="h-7 w-40 font-mono text-xs"
            />
            <Input
              aria-label="覆盖变量值"
              type="password"
              autoComplete="off"
              placeholder="value（空字符串是有效值）"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={!state.enabled}
              className="h-7 min-w-0 flex-1 font-mono text-xs"
            />
            <Button type="submit" size="sm" disabled={busy || !state.enabled || !name.trim()}>
              覆盖
            </Button>
          </form>
        </>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all text-foreground">{children}</dd>
    </>
  );
}

export function EnvironmentPane(props: EnvironmentPaneProps) {
  const ctx = useContext(WorkspaceContext);
  const workspace = props.workspace ?? ctx?.workspace;
  const loading = props.loading ?? ctx?.loading ?? false;
  const onUpdate = props.onUpdate ?? ctx?.onUpdate;
  const onChanged = props.onChanged ?? ctx?.onChanged;
  const { bot, vm } = props;
  const [resultFormOpen, setResultFormOpen] = useState(false);
  const [wsEnvVersion, setWsEnvVersion] = useState(0);
  const onResultReported = props.onResultReported ?? ctx?.onChanged;

  // The panel is not keyed by bot: switching sessions while the result form is open must drop the draft —
  // otherwise a summary typed for execution A posts to execution B's /result endpoint (cross-session result).
  const botId = bot?.id;
  useEffect(() => {
    setResultFormOpen(false);
  }, [botId]);

  if (!workspace) {
    return (
      <Empty className="h-full min-h-48">
        <EmptyDescription className="max-w-xs">
          {loading ? "加载中…" : "还没有工作区。新建一个工作区后，这里会显示它的环境信息。"}
        </EmptyDescription>
      </Empty>
    );
  }

  const agent = vm?.agent;
  const model = agent?.modelId ?? bot?.model.modelId ?? modelLabel(workspace.model);
  const env = envName(workspace);
  const baseSha = shortSha(workspace.baseCommit);
  // Issue-loop sessions and sessions added by hand (SPIKE-add-session) run in their own worktree: show THEIR git state,
  // never the workspace feature branch. PR review sessions (SPIKE-review-loop) are detached at the PR head SHA.
  const loop = bot?.issueLoop;
  const review = !loop ? bot?.review : undefined;
  // A worktree of its own: an issue-loop session, a review session, a session added by hand, or a Loop-run session
  // (Issue14: loopRun carries its own dir/pinnedSha/branch — never fall back to the workspace cwd for it).
  const loopRun = !loop && !review && bot?.loopRun?.dir ? bot.loopRun : undefined;
  const own = loop ?? (review ? { dir: review.dir, pinnedSha: review.headSha, branch: undefined } : undefined) ?? (bot?.worktree ? { dir: bot.worktree.dir, pinnedSha: bot.worktree.pinnedSha, branch: bot.worktree.branch } : undefined) ?? (loopRun ? { dir: loopRun.dir!, pinnedSha: loopRun.pinnedSha, branch: loopRun.branch ?? undefined } : undefined);
  // An execution session (has a source discussion Bot) can report its result back to the source issue.
  const isExecution = Boolean(loop?.sourceBotId);
  const result = bot?.executionResult;

  return (
    <div className="space-y-4 p-4">
      <dl
        className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 rounded-lg border border-border bg-card p-4 text-sm"
        data-testid="sprite-card"
        data-sandbox={workspace.binding?.provider ?? ""}
      >
        <Row label="工作区">{workspace.name}</Row>
        <Row label="仓库">
          <code className={code}>{workspace.repo}</code>
        </Row>
        <Row label="基准分支">
          <code className={code}>{workspace.baseBranch}</code>
          {baseSha && (
            <>
              {" "}
              <span className="text-muted-foreground">@</span> <code className={code}>{baseSha}</code>
            </>
          )}
        </Row>
        {own ? (
          <>
            <Row label="会话目录">
              <code className={code}>{own.dir}</code>
            </Row>
            <Row label="Git 状态">
              {own.branch ? (
                <code className={code}>{own.branch}</code>
              ) : (
                <span>
                  <code className={code}>detached @ {shortSha(own.pinnedSha) ?? own.pinnedSha}</code>
                  <span className="ml-2 text-xs text-muted-foreground">无功能分支</span>
                </span>
              )}
            </Row>
          </>
        ) : (
          <Row label="工作分支">
            <code className={code}>{workspace.branch}</code>
          </Row>
        )}
        <Row label="执行环境">
          {env ? (
            <>
              <code className={code}>{env}</code>
              {workspace.binding && <span className="ml-2 text-xs text-muted-foreground">绑定版本 v{workspace.binding.version}</span>}
            </>
          ) : (
            <span className="text-muted-foreground">尚未绑定</span>
          )}
        </Row>
        {model && (
          <Row label="模型">
            <code className={code}>{model}</code>
          </Row>
        )}
        {agent?.thinkingLevel && <Row label="Thinking">{agent.thinkingLevel}</Row>}
      </dl>

      {workspace.status !== "ready" && <WorkspaceStatus workspace={workspace} onUpdate={onUpdate} />}

      {/* SPIKE-review-loop: an execution session reports its human-written result; it feeds the source issue's
          overview card via the Bot record (aggregated by the parent from the session list). */}
      {bot && (isExecution || (bot.loopRun && result)) && (
        <section aria-label="执行结果" className="space-y-2">
          {result ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-lg border border-border bg-card p-4 text-sm" data-testid="execution-result">
              <Row label="结果摘要">{result.summary}</Row>
              <Row label="测试记录">
                {result.testsReportedByHuman ? (
                  <span>
                    {result.testsReportedByHuman} <span className="text-xs text-muted-foreground">（人工填写）</span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">未记录</span>
                )}
              </Row>
              {result.pull && (
                <Row label="关联 PR">
                  <a className="text-primary underline" href={result.pull.url} target="_blank" rel="noreferrer">
                    #{result.pull.number} {result.pull.title}
                  </a>
                  {result.pull.state && <span className="ml-2 text-xs text-muted-foreground">{result.pull.state}</span>}
                </Row>
              )}
              <Row label="上报于">{result.reportedAt}</Row>
            </dl>
          ) : resultFormOpen ? (
            <ResultForm
              key={bot.id}
              workspaceId={workspace.id}
              botId={bot.id}
              onReported={() => {
                setResultFormOpen(false);
                onResultReported?.();
              }}
              onCancel={() => setResultFormOpen(false)}
            />
          ) : (
            <Button type="button" variant="outline" size="sm" data-testid="open-result-form" onClick={() => setResultFormOpen(true)}>
              填写执行结果
            </Button>
          )}
        </section>
      )}
      {/* keyed: PR result, checkpoint list, request ids and dialogs are per workspace and must not leak to the next one.
          Issue-loop sessions are hidden: those workspace actions act on the old branch and main directory, not on this
          session’s own worktree (issue-loop spike: not extended, not offered). */}
      {/* remount keys: switching workspace/session drops every draft + pending async reply so a value typed
          for session A can never land in session B's override list. wsEnvVersion bumps when workspace vars
          change so the session panel re-reads the source names it can override. */}
      <WorkspaceEnvVars workspaceId={workspace.id} key={`ws-env-${workspace.id}`} onVarsChanged={() => setWsEnvVersion((v) => v + 1)} />
      {bot && !bot.readOnly && !bot.loopRun?.runId && (
        <SessionEnvVars key={`sess-env-${workspace.id}-${bot.id}`} botId={bot.id} refreshKey={wsEnvVersion} />
      )}
      {bot && (bot.readOnly || bot.loopRun?.runId) && (
        <p className="rounded-lg border border-border bg-card p-4 text-xs text-muted-foreground" data-testid="session-env-restricted">
          受限 Session（loop run / 只读 fork）：不继承工作区环境变量，也不可配置。
        </p>
      )}

      {!own && <WorkspaceActions key={workspace.id} workspace={workspace} onChanged={onChanged} />}
    </div>
  );
}
