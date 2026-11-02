import { Empty, EmptyDescription } from "../../components/ui/empty";

export function EmptyState() {
  return (
    <Empty>
      <EmptyDescription className="max-w-xs">
        No file changes in this conversation yet. Changes made by the edit/write tools show up here.
        <span className="mt-2 block text-xs opacity-70">Edits made through bash are not tracked.</span>
      </EmptyDescription>
    </Empty>
  );
}
