import { useMemo } from "react";
import { Icon } from "../../components/Chat/primitives/Icon";
import { cx } from "../../lib/cx";
import { tokenize } from "../../lib/highlight";
import type { DiffLine } from "../../lib/diff";
import type { ChangedFile } from "../../lib/turns";

const LANGS: Record<string, string> = {
  ts: "TS", mts: "TS", cts: "TS", tsx: "TSX", js: "JS", mjs: "JS", cjs: "JS", jsx: "JSX", py: "PY", md: "MD", sh: "SH", bash: "SH", json: "JSON",
};

export function extOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function langBadge(path: string): string {
  const ext = extOf(path);
  return LANGS[ext] ?? (ext ? ext.slice(0, 3).toUpperCase() : "TXT");
}

const SYN = {
  kw: "text-syn-kw", str: "text-syn-str", num: "text-syn-num", type: "text-syn-type", fn: "text-syn-fn", pun: "text-syn-pun", cm: "text-syn-cm",
} as const;

const rowCls: Record<string, string> = {
  add: "bg-diff-add border-l-2 border-l-ok",
  del: "bg-diff-del border-l-2 border-l-bad",
  ctx: "border-l-2 border-l-transparent",
};

function Row({ line, lang, wrap }: { line: DiffLine; lang: string; wrap: boolean }) {
  if (line.kind === "gap") {
    return (
      <div className="skip flex h-6 items-center justify-center bg-raised text-xs text-fg-faint" aria-label="unmodified lines">
        ⋯
      </div>
    );
  }
  const sign = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
  return (
    <div className={cx("flex", rowCls[line.kind])} data-kind={line.kind}>
      <span className="w-[60px] shrink-0 select-none pr-3 text-right text-fg-faint">{line.num ?? ""}</span>
      <span className={cx("min-w-0 flex-1 pr-3", wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre")}>
        <span aria-hidden className="select-none text-fg-faint">{sign} </span>
        {tokenize(line.text, lang).map((t, i) =>
          t.kind ? (
            <span key={i} className={SYN[t.kind]}>
              {t.text}
            </span>
          ) : (
            t.text
          ),
        )}
      </span>
    </div>
  );
}

interface Props {
  file: ChangedFile;
  collapsed: boolean;
  wrap: boolean;
  onToggle: () => void;
  selected?: boolean;
}

export function DiffFileCard({ file, collapsed, wrap, onToggle, selected }: Props) {
  const lang = extOf(file.path);
  const rows = useMemo(() => file.lines, [file.lines]);
  return (
    <section role="group" aria-label={`Changes in ${file.path}`} data-path={file.path} data-selected={selected || undefined} className="border-b border-line">
      <header className="sticky top-0 z-10 flex h-9 items-center gap-2 border-b border-line bg-surface px-3 text-xs">
        <button type="button" aria-expanded={!collapsed} aria-label={`${collapsed ? "Expand" : "Collapse"} ${file.path}`} onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <Icon name="chevron" className={cx("text-fg-muted transition-transform", !collapsed && "rotate-90")} />
          <span className="rounded bg-raised px-1.5 py-px font-mono text-[10px] text-fg-dim">{langBadge(file.path)}</span>
          <span className="min-w-0 truncate font-mono text-fg" title={file.path}>{file.path}</span>
        </button>
        <button
          type="button"
          aria-label="Copy path"
          onClick={() => void navigator.clipboard?.writeText(file.path)}
          className="rounded p-1 text-fg-muted hover:bg-hover hover:text-fg"
        >
          <Icon name="copy" />
        </button>
        <span className="shrink-0 font-mono">
          <span className="text-bad">−{file.del}</span> <span className="text-ok">+{file.add}</span>
        </span>
      </header>
      {!collapsed && (
        <div className={cx("py-1 font-mono text-[12.5px] leading-[1.7]", !wrap && "overflow-x-auto")}>
          <div className={cx(!wrap && "w-max min-w-full")}>
            {rows.map((l, i) => (
              <Row key={i} line={l} lang={lang} wrap={wrap} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
