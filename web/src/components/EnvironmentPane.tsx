import { useContext } from "react";
import { WorkspaceContext, envName, modelLabel, shortSha, type Workspace } from "../lib/workspaces";
import type { BotSummary, ConversationVM } from "../types";
import { WorkspaceActions, WorkspaceStatus } from "./WorkspaceStatus";

export interface EnvironmentPaneProps {
  /** Defaults to the selected workspace published through WorkspaceContext by the App. */
  workspace?: Workspace;
  loading?: boolean;
  onUpdate?: (ws: Workspace) => void;
  onChanged?: () => void;
  bot?: BotSummary;
  vm?: Pick<ConversationVM, "agent">;
}

const code = "rounded bg-[#1a1a1a] px-1.5 py-0.5 font-mono text-xs text-fg";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="min-w-0 break-all text-fg">{children}</dd>
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

  if (!workspace) {
    return <p className="p-4 text-sm text-fg-muted">{loading ? "加载中…" : "还没有工作区。新建一个工作区后，这里会显示它的环境信息。"}</p>;
  }

  const agent = vm?.agent;
  const model = agent?.modelId ?? bot?.model.modelId ?? modelLabel(workspace.model);
  const env = envName(workspace);
  const baseSha = shortSha(workspace.baseCommit);
  // Issue-loop sessions and sessions added by hand (SPIKE-add-session) run in their own worktree: show THEIR git state,
  // never the workspace feature branch.
  const loop = bot?.issueLoop;
  // A worktree of its own: an issue-loop session, or a session added by hand (its own record, no issue).
  const own = loop ?? (bot?.worktree ? { dir: bot.worktree.dir, pinnedSha: bot.worktree.pinnedSha, branch: undefined } : undefined);

  return (
    <div className="space-y-4 p-4">
      <dl
        className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 rounded-lg border border-line bg-raised p-4 text-sm"
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
              <span className="text-fg-muted">@</span> <code className={code}>{baseSha}</code>
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
                  <span className="ml-2 text-xs text-fg-muted">无功能分支</span>
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
              {workspace.binding && <span className="ml-2 text-xs text-fg-muted">绑定版本 v{workspace.binding.version}</span>}
            </>
          ) : (
            <span className="text-fg-muted">尚未绑定</span>
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
      {/* keyed: PR result, checkpoint list, request ids and dialogs are per workspace and must not leak to the next one.
          Issue-loop sessions are hidden: those workspace actions act on the old branch and main directory, not on this
          session’s own worktree (issue-loop spike: not extended, not offered). */}
      {!own && <WorkspaceActions key={workspace.id} workspace={workspace} onChanged={onChanged} />}
    </div>
  );
}
