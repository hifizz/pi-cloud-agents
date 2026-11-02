/**
 * Devin 风格 Prompt Composer —— 全插槽组件（vendored & 适配暗色 / hugeicons）。
 *
 * 每个 UI 元素都是独立组件，可单独替换而不影响其他部分：
 *
 *   <ComposerFrame>
 *     <ComposerRoot>
 *       <ComposerInput />
 *       <ComposerToolbar left={…} right={…} />
 *     </ComposerRoot>
 *     <ContextStrip items={[…]} />
 *   </ComposerFrame>
 */

export { ComposerFrame } from "./frame";
export { ComposerRoot } from "./root";
export { ComposerInput } from "./input";
export { ComposerToolbar } from "./toolbar";
export { IconButton, SelectPill } from "./primitives";
export { ActionButton } from "./action-button";
export { PermissionSelect, PERMISSION_MODES } from "./permission-select";
export type { ApprovalPolicy, PermissionMode } from "./permission-select";
export { StatusIndicator } from "./status-indicator";
export { SendButton } from "./send-button";
export { ContextStrip } from "./context-strip";
export type { ContextStripItem } from "./context-strip";
export { ComposerUsagePill } from "./usage-pill";
