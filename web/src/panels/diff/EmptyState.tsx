export function EmptyState() {
  return (
    <div className="flex flex-1 items-center justify-center p-8 text-center">
      <p className="max-w-xs text-sm text-fg-muted">
        No file changes in this conversation yet. Changes made by the edit/write tools show up here.
        <span className="mt-2 block text-xs text-fg-faint">Edits made through bash are not tracked.</span>
      </p>
    </div>
  );
}
