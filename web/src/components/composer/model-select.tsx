import { useState } from "react";
import { SelectPill } from "./primitives";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PopoverMenu, PopoverMenuItem } from "@/components/ui/popover-menu";
import { MODEL_OPTIONS } from "@/components/BotList";

/** Two-letter badge for the model pill: "tokenrouter/glm-5.3" → "GL". */
const abbr = (model: string) => (model.split("/").pop() ?? model).replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "M";

/** 模型选择器：触发器为 SelectPill（两字母徽章 + 显示串），下拉为 Popover + PopoverMenu。 */
export function ModelSelect({
  value,
  display,
  onChange,
}: {
  /** 当前模型 id（受控）。 */
  value?: string;
  /** 触发器上的完整显示串（如 "tokenrouter/swe-2"），缺省用 value。 */
  display?: string;
  onChange?: (modelId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = display ?? value ?? "";
  const options = value && !MODEL_OPTIONS.includes(value) ? [value, ...MODEL_OPTIONS] : MODEL_OPTIONS;

  const pick = (modelId: string) => {
    onChange?.(modelId);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <SelectPill
            icon={
              <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center rounded bg-muted text-[8px] font-semibold text-foreground">
                {abbr(label)}
              </span>
            }
            label={<span className="max-w-56 truncate">{label}</span>}
            title={label}
            aria-label={`模型：${value ?? label}`}
            aria-haspopup="listbox"
          />
        }
      />
      <PopoverContent align="start" side="top" sideOffset={8} className="w-56 p-0">
        <PopoverMenu>
          {options.map((m) => (
            <PopoverMenuItem key={m} selected={m === value} onClick={() => pick(m)}>
              {m}
            </PopoverMenuItem>
          ))}
        </PopoverMenu>
      </PopoverContent>
    </Popover>
  );
}
