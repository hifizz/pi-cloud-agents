import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { ChangedFile } from "../../../lib/turns";
import { tailClip } from "../../../lib/format";
import { cx } from "../../../lib/cx";
import { DiffStat, DiffView } from "../primitives/DiffView";
import { Collapse } from "../primitives/Collapse";
import { Icon } from "../primitives/Icon";

const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

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
    <Card aria-label="Changed files" role="region" className="gap-0 bg-card/60 py-0">
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={cx("flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2.5 text-left text-[13.5px] text-muted-foreground hover:bg-muted/60", focus)}
        >
          <Icon name="chevron" className={cx("text-muted-foreground/60 transition-transform", open && "rotate-90")} />
          <span>
            {files.length} changed file{files.length === 1 ? "" : "s"}
          </span>
          <DiffStat add={add} del={del} />
          <span className="flex-1" />
          <span className="text-xs text-muted-foreground/60">{open ? "Hide files" : "Show files"}</span>
        </button>
        {openDiff && (
          <Button type="button" variant="outline" size="xs" onClick={() => openDiff(files[0]?.path)} className="mx-2 shrink-0 gap-1.5 text-muted-foreground hover:text-foreground">
            <Icon name="diff" className="size-3.5" />
            Open diff
          </Button>
        )}
      </div>
      <Collapse open={open}>
        <ul className="border-t border-border py-1">
          {files.map((f) => (
            <li key={f.path}>
              <button
                type="button"
                onClick={() => (openDiff ? openDiff(f.path) : setFile(file === f.path ? undefined : f.path))}
                aria-expanded={openDiff ? undefined : file === f.path}
                className={cx("flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground", focus)}
              >
                <Icon name="file" className="text-muted-foreground/60" />
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
    </Card>
  );
}
