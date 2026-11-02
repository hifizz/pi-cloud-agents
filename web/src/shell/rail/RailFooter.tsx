import { auth } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { SidebarFooter } from "../../components/ui/sidebar";
import { Icon } from "../../components/Chat/primitives/Icon";

export function RailFooter({ email, onLoggedOut }: { email?: string; onLoggedOut?: () => void }) {
  if (!email) return null;
  return (
    <SidebarFooter>
      <span className="min-w-0 flex-1 truncate text-xs text-sidebar-foreground/60" title={email}>
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
    </SidebarFooter>
  );
}
