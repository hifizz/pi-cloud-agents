import { useState } from "react";
import type { ChangedFile } from "../../../lib/turns";
import { tailClip } from "../../../lib/format";
import { cx } from "../../../lib/cx";
import { DiffStat, DiffView } from "../primitives/DiffView";
import { Collapse } from "../primitives/Collapse";
import { Icon } from "../primitives/Icon";

const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/**
 * Per-turn summary card: every file the turn edited/wrote. With `onOpenDiff` the card offers "Open diff" and file rows
 * open the Changes panel; without it each row expands to an inline diff.
 */
export function FilesChanged({ files, turnKey, onOpenDiff }: { files: ChangedFile[]; turnKey?: string; onOpenDiff?: (turnKey: string, path?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<string>();
  const add = files.reduce((n, f) => n + f.add, 0);
  const del = files.reduce((n, f) => n + f.del, 0);
  const openDiff = onOpenDiff && turnKey !== undefined ? (path?: string) => onOpenDiff(turnKey, path) : undefined;
  return (
    <section aria-label="Changed files" className="overflow-hidden rounded-[10px] border border-line bg-[#0e0e0e]">
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={cx("flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2.5 text-left text-[13.5px] text-fg-dim hover:bg-hover", focus)}
        >
          <Icon name="chevron" className={cx("text-fg-faint transition-transform", open && "rotate-90")} />
          <span>
            {files.length} changed file{files.length === 1 ? "" : "s"}
          </span>
          <DiffStat add={add} del={del} />
          <span className="flex-1" />
          <span className="text-xs text-fg-faint">{open ? "Hide files" : "Show files"}</span>
        </button>
        {openDiff && (
          <button
            type="button"
            onClick={() => openDiff(files[0]?.path)}
            className={cx("mx-2 flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line-strong px-2 text-xs text-fg-dim hover:bg-hover hover:text-fg", focus)}
          >
            <Icon name="diff" className="size-3.5" />
            Open diff
          </button>
        )}
      </div>
      <Collapse open={open}>
        <ul className="border-t border-line py-1">
          {files.map((f) => (
            <li key={f.path}>
              <button
                type="button"
                onClick={() => (openDiff ? openDiff(f.path) : setFile(file === f.path ? undefined : f.path))}
                aria-expanded={openDiff ? undefined : file === f.path}
                className={cx("flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-fg-dim hover:bg-hover hover:text-fg", focus)}
              >
                <Icon name="file" className="text-fg-faint" />
                <span className="min-w-0 flex-1 truncate font-mono" title={f.path}>
                  {tailClip(f.path, 80)}
                </span>
                <DiffStat add={f.add} del={f.del} />
              </button>
              {!openDiff && (
                <Collapse open={file === f.path}>
                  <DiffView lines={f.lines} label={`Diff of ${f.path}`} className="mx-3 mb-2 rounded-md" />
                </Collapse>
              )}
            </li>
          ))}
        </ul>
      </Collapse>
    </section>
  );
}
