import { useState } from "react";
import type { ChangedFile } from "../../../lib/turns";
import { tailClip } from "../../../lib/format";
import { cx } from "../../../lib/cx";
import { DiffStat, DiffView } from "../primitives/DiffView";
import { Collapse } from "../primitives/Collapse";
import { Icon } from "../primitives/Icon";

/** Per-turn summary card: every file the turn edited/wrote, each expandable to its diff. */
export function FilesChanged({ files }: { files: ChangedFile[] }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<string>();
  const add = files.reduce((n, f) => n + f.add, 0);
  const del = files.reduce((n, f) => n + f.del, 0);
  return (
    <section aria-label="Changed files" className="overflow-hidden rounded-xl border border-zinc-800 bg-black/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13.5px] text-zinc-300 hover:bg-zinc-900/60 focus-visible:outline-2 focus-visible:outline-sky-400"
      >
        <Icon name="chevron" className={cx("text-zinc-600 transition-transform", open && "rotate-90")} />
        <span>
          {files.length} changed file{files.length === 1 ? "" : "s"}
        </span>
        <DiffStat add={add} del={del} />
        <span className="flex-1" />
        <span className="text-xs text-zinc-600">{open ? "Hide files" : "Show files"}</span>
      </button>
      <Collapse open={open}>
        <ul className="border-t border-zinc-800 py-1">
          {files.map((f) => (
            <li key={f.path}>
              <button
                type="button"
                onClick={() => setFile(file === f.path ? undefined : f.path)}
                aria-expanded={file === f.path}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-sky-400"
              >
                <Icon name="file" className="text-zinc-600" />
                <span className="min-w-0 flex-1 truncate font-mono" title={f.path}>
                  {tailClip(f.path, 80)}
                </span>
                <DiffStat add={f.add} del={f.del} />
              </button>
              <Collapse open={file === f.path}>
                <DiffView lines={f.lines} label={`Diff of ${f.path}`} className="mx-3 mb-2 rounded-md" />
              </Collapse>
            </li>
          ))}
        </ul>
      </Collapse>
    </section>
  );
}
