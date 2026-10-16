import type { ReactNode } from "react";
import { cx } from "../../../lib/cx";
import { Collapse } from "./Collapse";
import { Icon, type IconName } from "./Icon";

export interface ActivityRowProps {
  /** Leading glyph. Swapped for a chevron on hover / when open. Omit for a chevron-only row (e.g. "Thought"). */
  icon?: IconName;
  /** Short verb/name, e.g. "Shell", "Edit". */
  title: string;
  /** One-line target (command, path, query …), rendered monospace and truncated. */
  detail?: string;
  /** Right-aligned status / stats. */
  trailing?: ReactNode;
  open: boolean;
  onToggle: () => void;
  /** Disable the toggle when there is nothing to expand. */
  expandable?: boolean;
  /** Status colour for the icon. */
  tone?: "default" | "running" | "error" | "warn";
  testId?: string;
  titleAttr?: string;
  /** Always-visible content under the row while collapsed (e.g. screenshot thumbnails). */
  preview?: ReactNode;
  children?: ReactNode;
}

const ICON_TONE = { default: "text-fg-muted", running: "text-warn", error: "text-bad", warn: "text-warn" } as const;

/** The collapsible "one line per action" row used for every tool call. Content goes in `children`. */
export function ActivityRow({ icon, title, detail, trailing, open, onToggle, expandable = true, tone = "default", testId, titleAttr, preview, children }: ActivityRowProps) {
  return (
    <div data-testid={testId} className="border-l border-[#202020] pl-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expandable ? open : undefined}
        title={titleAttr}
        className="group/act flex w-full min-w-0 items-center gap-2 rounded py-0.5 text-left text-[13.5px] text-fg-dim hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          {expandable && <Icon name="chevron" className={cx("text-fg-faint transition-transform duration-150 ease-out", open && "rotate-90")} />}
        </span>
        {icon && <Icon name={icon} className={cx("shrink-0", ICON_TONE[tone])} />}
        <span className="shrink-0 text-fg-dim group-hover/act:text-fg">{title}</span>
        {detail ? <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted">{detail}</span> : <span className="flex-1" />}
        {trailing && <span className="flex shrink-0 items-center gap-2 text-[11.5px]">{trailing}</span>}
      </button>
      {preview && (
        <Collapse open={!open}>
          <div className="mb-1 ml-[22px] mt-1.5">{preview}</div>
        </Collapse>
      )}
      <Collapse open={open && !!children}>
        <div className="mb-1 ml-[22px] mt-1.5 space-y-2">{children}</div>
      </Collapse>
    </div>
  );
}
