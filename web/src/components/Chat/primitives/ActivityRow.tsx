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
  /** Status colour for the icon; there is deliberately no side rail. */
  tone?: "default" | "running" | "error" | "warn";
  testId?: string;
  titleAttr?: string;
  /** Always-visible content under the row while collapsed (e.g. screenshot thumbnails). */
  preview?: ReactNode;
  children?: ReactNode;
}

const ICON_TONE = { default: "text-zinc-500", running: "text-amber-400", error: "text-red-400", warn: "text-amber-500" } as const;

/** The collapsible "one line per action" row used for every tool call. Content goes in `children`. */
export function ActivityRow({ icon, title, detail, trailing, open, onToggle, expandable = true, tone = "default", testId, titleAttr, preview, children }: ActivityRowProps) {
  // One leading slot: icon at rest, chevron on hover/open (always a chevron when there is no icon).
  const showChevron = expandable && (!icon || open);
  return (
    <div data-testid={testId}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expandable ? open : undefined}
        title={titleAttr}
        className="group/act flex w-full min-w-0 items-center gap-2 rounded py-0.5 text-left text-[13.5px] text-zinc-400 hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-sky-400"
      >
        <span className="relative size-3.5 shrink-0">
          {icon && <Icon name={icon} className={cx("absolute inset-0 transition-opacity duration-150 ease-out", ICON_TONE[tone], expandable && (open ? "opacity-0" : "group-hover/act:opacity-0 group-focus-visible/act:opacity-0"))} />}
          {expandable && (
            <Icon
              name="chevron"
              className={cx("absolute inset-0 text-zinc-500 transition-[transform,opacity] duration-150 ease-out", open && "rotate-90", showChevron ? "opacity-100" : "opacity-0 group-hover/act:opacity-100 group-focus-visible/act:opacity-100")}
            />
          )}
        </span>
        <span className="shrink-0 text-zinc-300">{title}</span>
        {detail ? <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-500">{detail}</span> : <span className="flex-1" />}
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
