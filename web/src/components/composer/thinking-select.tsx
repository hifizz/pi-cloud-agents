import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Brain01Icon } from "@hugeicons/core-free-icons";
import { SelectPill } from "./primitives";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PopoverMenu, PopoverMenuItem } from "@/components/ui/popover-menu";

export type ThinkingLevelId = "off" | "low" | "medium" | "high" | "max";

export type ThinkingLevelOption = {
  id: ThinkingLevelId;
  label: string;
  description: string;
};

/** 思考强度文案：id 与后端 ModelThinkingLevel 一致。"off" 表示不发送 reasoning_effort（模型默认行为）。 */
export const THINKING_LEVELS: Record<ThinkingLevelId, ThinkingLevelOption> = {
  off: { id: "off", label: "默认", description: "不指定强度，使用模型默认" },
  low: { id: "low", label: "低", description: "较少思考，更快更省" },
  medium: { id: "medium", label: "中", description: "中等思考强度" },
  high: { id: "high", label: "高", description: "更多思考，适合复杂任务" },
  max: { id: "max", label: "最大", description: "最高思考强度" },
};

/**
 * 思考强度选择器：触发器为 SelectPill，下拉为 Popover + PopoverMenu。
 * `options` 由调用方从后端 GET /thinking-levels 取得（该模型真实可配置的档位）；
 * 空列表表示当前模型不支持配置，渲染为禁用态而不是假菜单。
 */
export function ThinkingSelect({
  value,
  options,
  disabled,
  saving,
  loadFailed,
  onRetry,
  onChange,
}: {
  /** 当前生效档位（受控）；"off" 或缺省显示为"默认"。 */
  value?: ThinkingLevelId;
  /** 当前模型可选的档位 id（不含 "off"，"默认"项始终提供）。空数组 → 禁用展示。 */
  options: ThinkingLevelId[];
  /** 会话不可写时禁用。 */
  disabled?: boolean;
  /** 保存中：防重复请求。 */
  saving?: boolean;
  /** 能力加载失败：pill 变为可点击的重试入口，而不是假装模型不支持。 */
  loadFailed?: boolean;
  onRetry?: () => void;
  onChange?: (level: ThinkingLevelId) => void;
}) {
  const [open, setOpen] = useState(false);
  const supported = options.length > 0;
  const current = value && value !== "off" ? value : "off";
  const currentOption = THINKING_LEVELS[current] ?? THINKING_LEVELS.off;
  const shown: ThinkingLevelId[] = ["off", ...options];
  const unavailable = !supported;

  const pick = (id: ThinkingLevelId) => {
    onChange?.(id);
    setOpen(false);
  };

  if (loadFailed) {
    return (
      <SelectPill
        icon={<HugeiconsIcon icon={Brain01Icon} className="size-3.5" strokeWidth={1.8} />}
        label="思考：加载失败"
        title="思考强度选项加载失败，点击重试"
        aria-label="思考强度选项加载失败，点击重试"
        onClick={onRetry}
      />
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <SelectPill
            icon={<HugeiconsIcon icon={Brain01Icon} className="size-3.5" strokeWidth={1.8} />}
            label={`思考：${unavailable ? "—" : currentOption.label}`}
            title={
              unavailable
                ? "当前模型暂不支持配置思考强度"
                : `思考强度：${currentOption.label}（对后续请求生效）`
            }
            aria-label={unavailable ? "思考强度：当前模型不支持配置" : `思考强度：${currentOption.label}`}
            aria-haspopup="listbox"
            disabled={disabled || saving || unavailable}
            onClick={() => setOpen(true)}
          />
        }
      />
      <PopoverContent align="start" side="top" sideOffset={8} className="w-56 p-0">
        <PopoverMenu>
          {shown.map((id) => {
            const opt = THINKING_LEVELS[id];
            return (
              <PopoverMenuItem
                key={id}
                icon={<HugeiconsIcon icon={Brain01Icon} className="size-[15px]" strokeWidth={1.6} />}
                description={opt.description}
                selected={id === current}
                onClick={() => pick(id)}
              >
                {opt.label}
              </PopoverMenuItem>
            );
          })}
        </PopoverMenu>
      </PopoverContent>
    </Popover>
  );
}
