import { useState, type FormEvent } from "react";
import type { ForkInput } from "../types";
import { MODEL_OPTIONS } from "./BotList";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export interface ForkDialogProps {
  parentName: string;
  entryId?: number | string;
  /** Model preselected (defaults to the first option). */
  defaultModelId?: string;
  onSubmit: (input: ForkInput) => Promise<void>;
  onClose: () => void;
}

export function ForkDialog({ parentName, entryId, defaultModelId, onSubmit, onClose }: ForkDialogProps) {
  const options = defaultModelId && !MODEL_OPTIONS.includes(defaultModelId) ? [defaultModelId, ...MODEL_OPTIONS] : MODEL_OPTIONS;
  const [name, setName] = useState("");
  const [modelId, setModelId] = useState(defaultModelId ?? MODEL_OPTIONS[0]);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

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
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      {/* Native <select> stays: Base UI's Select cannot submit a different option in tests (selectOptions). */}
      <DialogContent aria-labelledby="fork-title" showCloseButton={false} className="w-96">
        <DialogTitle id="fork-title" className="text-sm font-semibold">
          Fork from here
        </DialogTitle>
        <DialogDescription className="-mt-2 text-xs">
          从“{parentName}”的这个位置分出一个会话。这是只读副本，用于查看和讨论，不会修改文件。
        </DialogDescription>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <Label htmlFor="fork-name" className="mb-1 text-xs text-muted-foreground">
              New bot name
            </Label>
            <Input id="fork-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus autoComplete="off" />
          </div>
          <div>
            <Label htmlFor="fork-model" className="mb-1 text-xs text-muted-foreground">
              Model
            </Label>
            <select
              id="fork-model"
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            >
              {options.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <p className="rounded-md border border-border bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground" data-testid="fork-readonly-note">
            只读副本：只能读取，不能执行命令或修改文件。
          </p>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !name.trim()}>
              Fork
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
