import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { HelpCircleIcon, ZapIcon, ShieldIcon } from "@hugeicons/core-free-icons";
import { SelectPill } from "./primitives";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PopoverMenu, PopoverMenuItem } from "@/components/ui/popover-menu";

export type ApprovalPolicy = "ask" | "auto";

export type PermissionMode = {
  id: ApprovalPolicy;
  label: string;
  description: string;
  icon: React.ReactNode;
};

/** 权限模式目录：对应后端 approval-policy（ask / auto）。 */
export const PERMISSION_MODES: readonly PermissionMode[] = [
  {
    id: "ask",
    label: "询问",
    description: "危险操作需审批",
    icon: <HugeiconsIcon icon={HelpCircleIcon} className="size-[15px]" strokeWidth={1.6} />,
  },
  {
    id: "auto",
    label: "自动批准",
    description: "危险操作不再停车",
    icon: <HugeiconsIcon icon={ZapIcon} className="size-[15px]" strokeWidth={1.6} />,
  },
];

/** 权限模式选择器：触发器为 SelectPill，下拉为 base-ui Popover + PopoverMenu。 */
export function PermissionSelect({
  value = "ask",
  onChange,
}: {
  /** 当前模式（受控）。 */
  value?: ApprovalPolicy;
  onChange?: (policy: ApprovalPolicy) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = PERMISSION_MODES.find((m) => m.id === value) ?? PERMISSION_MODES[0];

  const pick = (id: ApprovalPolicy) => {
    onChange?.(id);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <SelectPill
            icon={<HugeiconsIcon icon={ShieldIcon} className="size-3.5" strokeWidth={1.8} />}
            label={current.label}
            aria-label={`权限模式：${current.label}`}
            aria-haspopup="listbox"
          />
        }
      />
      <PopoverContent align="start" side="top" sideOffset={8} className="w-72 p-0">
        <PopoverMenu>
          {PERMISSION_MODES.map((m) => (
            <PopoverMenuItem
              key={m.id}
              icon={m.icon}
              description={m.description}
              selected={m.id === value}
              onClick={() => pick(m.id)}
            >
              {m.label}
            </PopoverMenuItem>
          ))}
        </PopoverMenu>
      </PopoverContent>
    </Popover>
  );
}
