// Per-conversation ExecutionEnv routing (M1-05). The harness calls the factory with {conversationId, cwd} on every use.
// Resolution: conversation -> workspace -> active binding -> provider bash primitive -> SandboxEnv.
// Anything not ready throws an Error with the reason (the tool then sees a visible tool_error). There is NO fallback to
// any global sandbox, and the factory has no side effects: no network, no writes.
import { SandboxEnv } from "./env.mjs";

/** Sandbox home used when a provider does not publish one (Sprites). */
export const DEFAULT_HOME = "/home/sprite";

const notReady = (detail) => new Error(`工作区未就绪：${detail}`);

/** Name the step that explains why a preparing/failed workspace is not usable. */
function stepReason(store, workspace) {
  let steps = [];
  try {
    steps = store.workspaces.steps(workspace.id) ?? [];
  } catch {
    // reading steps is best-effort; the status alone is already a reason
  }
  const bad = steps.find((s) => s.state === "failed" || s.state === "unknown") ?? steps.find((s) => s.state === "running");
  const step = bad ? `${bad.step} ` : "";
  const reason = bad?.error || workspace.error || (workspace.status === "preparing" ? "仍在准备中" : "");
  return `${step}${reason}`.trim() || workspace.status;
}

/**
 * @param {{ store: any, providers: Record<string, { bash: (runtimeId: string) => Function, home?: string }> }} deps
 * @returns {(target: { conversationId: string, cwd?: string }) => SandboxEnv}
 */
export function createWorkspaceEnv({ store, providers }) {
  if (!store) throw new TypeError("createWorkspaceEnv requires a store");
  const table = providers ?? {};
  return ({ conversationId, cwd } = {}) => {
    // Pi Durable conversation ids are numbers; the control store keys them as text.
    const workspace = conversationId !== undefined && conversationId !== null && conversationId !== "" ? store.links.workspaceOf(String(conversationId)) : undefined;
    if (!workspace) throw notReady(`会话 ${conversationId ?? "(未知)"} 没有关联工作区`);
    if (workspace.status !== "ready") {
      throw notReady(`${workspace.status === "archived" ? "已归档" : stepReason(store, workspace)}（工作区 ${workspace.id}，状态 ${workspace.status}）`);
    }
    const binding = store.bindings.current(workspace.id);
    if (!binding) throw notReady(`工作区 ${workspace.id} 没有 active 运行环境绑定`);
    const provider = Object.hasOwn(table, binding.provider) ? table[binding.provider] : undefined;
    if (!provider || typeof provider.bash !== "function") {
      throw notReady(`供应商 ${binding.provider} 未注册（工作区 ${workspace.id}）`);
    }
    const dir = cwd ?? workspace.cwd;
    if (!dir) throw notReady(`工作区 ${workspace.id} 没有工作目录`);
    return new SandboxEnv({
      cwd: dir,
      bash: provider.bash(binding.runtimeId),
      home: typeof provider.home === "string" && provider.home ? provider.home : DEFAULT_HOME,
      id: `${binding.provider}:${binding.runtimeId}:v${binding.version}`,
    });
  };
}
