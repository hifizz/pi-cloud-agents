import { useState, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Clock01Icon, StopIcon, QueueIcon } from "@hugeicons/core-free-icons";
import {
  ActionButton,
  ComposerFrame,
  ComposerInput,
  ComposerRoot,
  ComposerToolbar,
  ContextStrip,
  ModelIcon,
  ModelSelect,
  PermissionSelect,
  SendButton,
  StatusIndicator,
  ThinkingSelect,
  type ApprovalPolicy,
  type ContextStripItem,
  type ThinkingLevelId,
} from "@/components/composer";

export type SendMode = "send" | "steer" | "followUp";

export interface ComposerProps {
  busy: boolean;
  disabled?: boolean;
  /** Shown as a pill in the toolbar (e.g. "tokenrouter/glm-5.3"); display only, no switching. */
  model?: string;
  /** Current model id; with `onModelChange` the pill becomes a model picker. */
  modelId?: string;
  /** Called when the user picks a different model. Absent → static pill. */
  onModelChange?: (modelId: string) => void;
  /** Thinking levels the current model accepts (e.g. ["medium","high","max"]); empty = unsupported model
   *  (selector renders disabled); undefined = capability not loaded yet (selector hidden). */
  thinkingLevels?: ThinkingLevelId[];
  /** Effective thinking level for the session ("off" = model default). */
  thinkingLevel?: ThinkingLevelId;
  /** Called when the user picks a different thinking level. */
  onThinkingLevelChange?: (level: ThinkingLevelId) => void;
  /** True while a thinking-level PATCH is in flight; the selector stays disabled. */
  thinkingLevelSaving?: boolean;
  /** Capability load failed: the selector shows a retry affordance instead of an unsupported state. */
  thinkingLevelsLoadFailed?: boolean;
  onThinkingLevelsRetry?: () => void;
  /** Messages waiting in the bot's inbox. */
  queued?: number;
  onSend: (text: string, mode: SendMode) => void | Promise<void>;
  onAbort: () => void | Promise<void>;
  /** Approval policy of this session; rendered as the PermissionSelect pill. */
  approvalPolicy?: ApprovalPolicy;
  /** Called when the user picks a different approval policy. */
  onApprovalPolicyChange?: (policy: ApprovalPolicy) => void;
  /** Read-only context row under the input card (cwd, branch, …). Content owned by the caller. */
  contextItems?: ContextStripItem[];
  /** Free-form strip rendered under the input card (kept for callers that compose their own strip). */
  context?: ReactNode;
  /** Status rendered at the trailing (right) end of the context strip. Content owned by the caller. */
  status?: ReactNode;
}

export function Composer({
  busy,
  disabled,
  model,
  modelId,
  onModelChange,
  thinkingLevels,
  thinkingLevel,
  onThinkingLevelChange,
  thinkingLevelSaving,
  thinkingLevelsLoadFailed,
  onThinkingLevelsRetry,
  queued = 0,
  onSend,
  onAbort,
  approvalPolicy,
  onApprovalPolicyChange,
  contextItems,
  context,
  status,
}: ComposerProps) {
  const [text, setText] = useState("");
  const empty = text.trim().length === 0;

  const submit = async (mode: SendMode) => {
    const value = text.trim();
    if (!value || disabled) return;
    setText("");
    try {
      await onSend(value, mode);
    } catch {
      setText(value); // keep the draft if submission failed
    }
  };

  return (
    <div className="bg-gradient-to-t from-background via-background to-transparent px-[18px] pb-4 pt-6">
      <div className="mx-auto max-w-[720px]">
        <ComposerFrame>
          <ComposerRoot>
            <label htmlFor="composer-input" className="sr-only">
              Message
            </label>
            <ComposerInput
              id="composer-input"
              value={text}
              onValueChange={setText}
              onSubmit={() => void submit(busy ? "steer" : "send")}
              disabled={disabled}
              placeholder={busy ? "Bot is working — Enter to steer, or queue a follow-up" : "Ask for changes, send follow-ups…"}
              className="min-h-14 px-4 pt-3.5 pb-1 text-[14.5px]"
            />
            <ComposerToolbar
              left={
                <>
                  {approvalPolicy && <PermissionSelect value={approvalPolicy} onChange={onApprovalPolicyChange} />}
                  {model &&
                    (onModelChange ? (
                      <ModelSelect value={modelId} display={model} onChange={onModelChange} />
                    ) : (
                      <span
                        title={model}
                        className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] whitespace-nowrap text-foreground/80"
                      >
                        <ModelIcon modelId={model} />
                        <span className="max-w-56 truncate">{model}</span>
                      </span>
                    ))}
                  {(thinkingLevels !== undefined || thinkingLevelsLoadFailed) && (
                    <ThinkingSelect
                      value={thinkingLevel}
                      options={thinkingLevels ?? []}
                      disabled={disabled}
                      saving={thinkingLevelSaving}
                      loadFailed={thinkingLevelsLoadFailed}
                      onRetry={onThinkingLevelsRetry}
                      onChange={onThinkingLevelChange}
                    />
                  )}
                </>
              }
              right={
                <>
                  {queued > 0 && (
                    <span className="flex items-center gap-1 px-1 text-[11px] text-muted-foreground">
                      <HugeiconsIcon icon={Clock01Icon} className="size-3" />
                      {queued} queued
                    </span>
                  )}
                  <StatusIndicator active={busy} />
                  {busy && (
                    <>
                      <ActionButton
                        variant="destructive"
                        icon={<HugeiconsIcon icon={StopIcon} className="size-3" />}
                        onClick={() => void onAbort()}
                      >
                        Abort
                      </ActionButton>
                      <ActionButton
                        variant="secondary"
                        icon={<HugeiconsIcon icon={QueueIcon} className="size-3" />}
                        disabled={empty || disabled}
                        onClick={() => void submit("followUp")}
                      >
                        Queue
                      </ActionButton>
                    </>
                  )}
                  <SendButton busy={busy} disabled={empty || disabled} onSend={() => void submit(busy ? "steer" : "send")} />
                </>
              }
            />
          </ComposerRoot>
          {(contextItems && contextItems.length > 0) || status ? (
            <ContextStrip items={contextItems ?? []} trailing={status} />
          ) : null}
        </ComposerFrame>
        {context}
      </div>
    </div>
  );
}
