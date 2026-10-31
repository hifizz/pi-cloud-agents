// Files panel (AMP13-files): browse the selected session's working directory on its Sprite, read a
// file's content and upload a small file. The server confines everything to the session root
// (src/routes/files.mjs + src/files-env.mjs): symlink escapes, .env* / .git and >1 MiB uploads are
// refused. The panel talks to /api/bots/:id/files/* directly — nothing is mocked.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { Icon } from "../../components/Chat/primitives/Icon";
import { cx } from "../../lib/cx";
import type { PanelContext, PanelDefinition } from "../types";

interface FileEntry {
  name: string;
  /** Path relative to the session root. */
  path: string;
  kind: "file" | "directory" | "symlink";
  size: number;
  mtimeMs: number;
  protected?: boolean;
}

interface ListReply {
  path: string;
  root: string;
  entries: FileEntry[];
  truncated: boolean;
}

interface ReadReply {
  path: string;
  size: number;
  mtimeMs: number;
  base64: string;
}

interface ApiErrorShape {
  error?: string;
}

async function apiCall<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let payload: (T & ApiErrorShape) | undefined;
  try {
    payload = text ? (JSON.parse(text) as T & ApiErrorShape) : undefined;
  } catch {
    payload = undefined;
  }
  if (!res.ok) throw new Error(payload?.error ?? `HTTP ${res.status}`);
  return payload as T;
}

const enc = encodeURIComponent;

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

/** Crumb segments of a relative path ("a/b/c" -> ["a", "a/b", "a/b/c"]). */
function crumbs(path: string): { label: string; path: string }[] {
  if (path === "." || path === "") return [];
  const parts = path.split("/");
  return parts.map((p, i) => ({ label: p, path: parts.slice(0, i + 1).join("/") }));
}

function FilesView({ bot }: { bot: NonNullable<PanelContext["bot"]> }) {
  const [dir, setDir] = useState<string>(".");
  const [list, setList] = useState<ListReply | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ path: string; reply: ReadReply } | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const seq = useRef(0);

  const load = useCallback(
    async (path: string) => {
      const n = ++seq.current;
      setLoading(true);
      setError(null);
      try {
        const r = await apiCall<ListReply>("GET", `/api/bots/${enc(bot.id)}/files/list?path=${enc(path)}`);
        if (n !== seq.current) return;
        setList(r);
        setDir(r.path);
        setOpen(null);
      } catch (e) {
        if (n !== seq.current) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (n === seq.current) setLoading(false);
      }
    },
    [bot.id],
  );

  useEffect(() => {
    setDir(".");
    setList(null);
    setOpen(null);
    void load(".");
  }, [bot.id, load]);

  const openFile = useCallback(
    async (entry: FileEntry) => {
      setError(null);
      try {
        const reply = await apiCall<ReadReply>("GET", `/api/bots/${enc(bot.id)}/files/read?path=${enc(entry.path)}`);
        setOpen({ path: entry.path, reply });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [bot.id],
  );

  const upload = useCallback(
    async (file: File) => {
      setError(null);
      setUploading(true);
      try {
        const base64 = await readFileAsBase64(file);
        const path = dir === "." ? file.name : `${dir}/${file.name}`;
        try {
          await apiCall("POST", `/api/bots/${enc(bot.id)}/files/write`, { path, base64 });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/exists/i.test(msg) && window.confirm(`${path} 已存在，覆盖？`)) {
            await apiCall("POST", `/api/bots/${enc(bot.id)}/files/write`, { path, base64, overwrite: true });
          } else {
            throw e;
          }
        }
        await load(dir);
        // Show the file right away so the upload is visibly confirmed.
        const reply = await apiCall<ReadReply>("GET", `/api/bots/${enc(bot.id)}/files/read?path=${enc(path)}`);
        setOpen({ path, reply });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setUploading(false);
      }
    },
    [bot.id, dir, load],
  );

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (f) void upload(f);
  };

  const openedText = useMemo(() => {
    if (!open) return null;
    try {
      return new TextDecoder("utf-8", { fatal: false }).decode(b64ToBytes(open.reply.base64));
    } catch {
      return "(binary file)";
    }
  }, [open]);

  return (
    <div className="flex h-full flex-col text-sm">
      <div className="flex items-center gap-1 border-b border-zinc-800 px-2 py-1.5">
        <button
          type="button"
          className="rounded px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          onClick={() => void load(".")}
          title="Session root"
          aria-label="Session root"
        >
          <Icon name="folder" className="inline h-4 w-4" />
        </button>
        <nav aria-label="Path" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {crumbs(dir).map((c) => (
            <button
              key={c.path}
              type="button"
              className="whitespace-nowrap rounded px-1 py-0.5 text-zinc-300 hover:bg-zinc-800"
              onClick={() => void load(c.path)}
            >
              {c.label}
            </button>
          ))}
        </nav>
        <button
          type="button"
          className="rounded px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          onClick={() => void load(dir)}
          disabled={loading}
          aria-label="Refresh"
          title="Refresh"
        >
          <Icon name="history" className="inline h-4 w-4" />
        </button>
        <button
          type="button"
          className="rounded px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          onClick={() => fileInput.current?.click()}
          disabled={uploading || !list || bot.readOnly || Boolean(bot.loopRun && bot.loopRun.capabilities?.code !== "readwrite")}
          aria-label="Upload file"
          title="Upload file"
        >
          <Icon name="filePlus" className="inline h-4 w-4" />
        </button>
        <input ref={fileInput} type="file" className="hidden" aria-label="Choose file" onChange={onPick} />
      </div>
      {error && (
        <div role="alert" className="border-b border-red-900/60 bg-red-950/40 px-3 py-1.5 text-red-300">
          {error}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <ul className="w-2/5 shrink-0 overflow-y-auto border-r border-zinc-800" aria-label="Directory listing">
          {loading && <li className="px-3 py-2 text-zinc-500">Loading…</li>}
          {!loading && list?.entries.length === 0 && <li className="px-3 py-2 text-zinc-500">(empty)</li>}
          {list?.entries.map((e) => (
            <li key={e.path}>
              <button
                type="button"
                className={cx(
                  "flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-zinc-800/70",
                  open?.path === e.path && "bg-zinc-800",
                  e.protected && "opacity-50",
                )}
                title={e.protected ? `${e.name} (protected)` : e.path}
                onClick={() => {
                  if (e.kind === "directory") void load(e.path);
                  else void openFile(e);
                }}
              >
                <Icon name={e.kind === "directory" ? "folder" : "file"} className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                <span className="min-w-0 flex-1 truncate text-zinc-200">{e.name}</span>
                {e.kind === "symlink" && <span className="text-zinc-500">↗</span>}
                {e.kind === "file" && <span className="shrink-0 text-[11px] text-zinc-500">{formatSize(e.size)}</span>}
              </button>
            </li>
          ))}
          {list?.truncated && <li className="px-3 py-1 text-[11px] text-zinc-500">…truncated</li>}
        </ul>
        <div className="min-w-0 flex-1 overflow-auto">
          {open ? (
            <div className="p-2">
              <div className="mb-1 flex items-center justify-between gap-2 px-1 text-[12px] text-zinc-400">
                <span className="truncate" title={open.path}>
                  {open.path}
                </span>
                <span className="shrink-0">{formatSize(open.reply.size)}</span>
              </div>
              <pre className="whitespace-pre-wrap break-all rounded bg-zinc-900 p-2 text-[12px] leading-relaxed text-zinc-200">
                {openedText}
              </pre>
            </div>
          ) : (
            <div className="p-4 text-zinc-500">Select a file to view its contents.</div>
          )}
        </div>
      </div>
    </div>
  );
}

const Component = ({ bot }: PanelContext) => {
  if (!bot) return <div className="p-4 text-sm text-zinc-500">Select a session to browse its files.</div>;
  return <FilesView bot={bot} />;
};

export const filesPanel: PanelDefinition = {
  id: "files",
  title: "Files",
  icon: "folder",
  Component,
};
