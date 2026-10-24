import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ForkInput } from "../types";
import { MODEL_OPTIONS } from "./BotList";

export interface ForkDialogProps {
  parentName: string;
  entryId?: number | string;
  /** Model preselected (defaults to the first option). */
  defaultModelId?: string;
  onSubmit: (input: ForkInput) => Promise<void>;
  onClose: () => void;
}

const field =
  "w-full rounded-md border border-line-strong bg-field px-2 py-1.5 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-2 focus-visible:outline-accent";

export function ForkDialog({ parentName, entryId, defaultModelId, onSubmit, onClose }: ForkDialogProps) {
  const options = defaultModelId && !MODEL_OPTIONS.includes(defaultModelId) ? [defaultModelId, ...MODEL_OPTIONS] : MODEL_OPTIONS;
  const [name, setName] = useState("");
  const [modelId, setModelId] = useState(defaultModelId ?? MODEL_OPTIONS[0]);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => nameRef.current?.focus(), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    setError(undefined);
    try {
      // M1: forks are always read-only copies (a second writer needs the workspace write lock, which comes later).
      await onSubmit({ name: name.trim(), modelId, readOnly: true, ...(entryId !== undefined ? { entryId } : {}) });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="fork-title"
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        className="w-96 max-w-[90vw] rounded-lg border border-line-strong bg-raised p-4 shadow-xl"
      >
        <h2 id="fork-title" className="text-sm font-semibold text-fg">
          Fork from here
        </h2>
        <p className="mt-0.5 text-xs text-fg-muted">
          从“{parentName}”的这个位置分出一个会话。这是只读副本，用于查看和讨论，不会修改文件。
        </p>
        <form onSubmit={submit} className="mt-3 space-y-3">
          <div>
            <label htmlFor="fork-name" className="mb-1 block text-xs text-fg-muted">
              New bot name
            </label>
            <input id="fork-name" ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} required className={field} autoComplete="off" />
          </div>
          <div>
            <label htmlFor="fork-model" className="mb-1 block text-xs text-fg-muted">
              Model
            </label>
            <select id="fork-model" value={modelId} onChange={(e) => setModelId(e.target.value)} className={field}>
              {options.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <p className="rounded-md border border-line bg-field px-2 py-1.5 text-xs text-fg-muted" data-testid="fork-readonly-note">
            只读副本：只能读取，不能执行命令或修改文件。
          </p>
          {error && (
            <p role="alert" className="text-xs text-bad">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-line-strong px-3 py-1.5 text-sm text-fg-dim hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !name.trim()}
              className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
            >
              Fork
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
