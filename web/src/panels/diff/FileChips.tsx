import { cn } from "../../lib/utils";
import type { ChangedFile } from "../../lib/turns";

export const basename = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

export function FileChips({ files, selected, onSelect }: { files: ChangedFile[]; selected?: string; onSelect: (path: string) => void }) {
  return (
    <div role="toolbar" aria-label="Changed files" className="flex h-10 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border px-3">
      {files.map((f) => (
        <button
          key={f.path}
          type="button"
          title={f.path}
          aria-pressed={f.path === selected}
          onClick={() => onSelect(f.path)}
          className={cn(
            "flex h-6 shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs",
            f.path === selected ? "border-border bg-muted text-foreground" : "border-border text-muted-foreground hover:bg-muted/60",
          )}
        >
          <span>{basename(f.path)}</span>
          <span className="font-mono text-ok">+{f.add}</span>
          <span className="font-mono text-bad">−{f.del}</span>
        </button>
      ))}
    </div>
  );
}
