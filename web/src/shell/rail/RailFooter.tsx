import { auth } from "../../lib/api";
import { Icon } from "../../components/Chat/primitives/Icon";

export function RailFooter({ email, onLoggedOut }: { email?: string; onLoggedOut?: () => void }) {
  if (!email) return null;
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-t border-line px-3">
      <span className="min-w-0 flex-1 truncate text-xs text-fg-muted" title={email}>
        {email}
      </span>
      <button
        type="button"
        onClick={() => {
          void auth
            .logout()
            .catch(() => {})
            .finally(() => onLoggedOut?.());
        }}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line-strong px-2 text-xs text-fg-dim hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
      >
        <Icon name="logout" className="size-3" />
        退出
      </button>
    </div>
  );
}
