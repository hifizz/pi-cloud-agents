import { auth } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/Chat/primitives/Icon";

export function RailFooter({ email, onLoggedOut }: { email?: string; onLoggedOut?: () => void }) {
  if (!email) return null;
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-t border-sidebar-border px-3">
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={email}>
        {email}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          void auth
            .logout()
            .catch(() => {})
            .finally(() => onLoggedOut?.());
        }}
        className="h-7 shrink-0 text-xs"
      >
        <Icon name="logout" className="size-3" />
        退出
      </Button>
    </div>
  );
}
