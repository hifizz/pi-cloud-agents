import type { BotSummary, ConversationVM, SpaceInfo } from "../types";

const SANDBOX_LABELS: Record<SpaceInfo["sandbox"], string> = {
  sprites: "Sprite",
  e2b: "E2B",
  instabox: "InstaBox",
};

/** Fallbacks when the server does not report `cwd` (config.spaceCwd). */
const SANDBOX_WORKDIRS: Record<SpaceInfo["sandbox"], string> = {
  sprites: "/home/sprite/workspace",
  e2b: "/home/user/workspace",
  instabox: "/data/home/workspace",
};

export interface EnvironmentPaneProps {
  /** GET /api/space; undefined while loading (or after `failed`). */
  space?: SpaceInfo;
  failed?: boolean;
  bot?: BotSummary;
  vm?: Pick<ConversationVM, "agent">;
}

export function EnvironmentPane({ space, failed = false, bot, vm }: EnvironmentPaneProps) {
  if (!space) {
    return <p className="p-4 text-sm text-fg-muted">{failed ? "执行环境信息不可用" : "加载中…"}</p>;
  }
  const agent = vm?.agent;
  const model = agent?.modelId ?? bot?.model.modelId;
  const cwd = agent?.cwd ?? space.cwd ?? SANDBOX_WORKDIRS[space.sandbox];
  const code = "rounded bg-[#1a1a1a] px-1.5 py-0.5 font-mono text-xs text-fg";
  return (
    <dl
      className="m-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 rounded-lg border border-line bg-raised p-4 text-sm"
      data-testid="sprite-card"
      data-sandbox={space.sandbox}
    >
      <dt className="text-xs text-fg-muted">执行环境</dt>
      <dd className="min-w-0 text-fg">
        {SANDBOX_LABELS[space.sandbox]} <code className={code}>{space.name ?? "(未配置)"}</code>
      </dd>
      <dt className="text-xs text-fg-muted">工作目录</dt>
      <dd className="min-w-0 break-all">
        <code className={code}>{cwd}</code>
      </dd>
      {model && (
        <>
          <dt className="text-xs text-fg-muted">模型</dt>
          <dd className="min-w-0 break-all">
            <code className={code}>{model}</code>
          </dd>
        </>
      )}
      {agent?.thinkingLevel && (
        <>
          <dt className="text-xs text-fg-muted">Thinking</dt>
          <dd className="text-fg">{agent.thinkingLevel}</dd>
        </>
      )}
    </dl>
  );
}
