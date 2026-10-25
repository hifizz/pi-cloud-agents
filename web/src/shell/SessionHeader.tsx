// Conversation header (reference `.c-head`): breadcrumb + connection state + actions + panel toggle.
import { UsageBadge } from "../components/UsageBadge";
import { Icon } from "../components/Chat/primitives/Icon";
import type { BotSummary, ConversationVM, SpaceInfo, StreamStatus } from "../types";

export interface SessionHeaderProps {
  bot?: BotSummary;
  vm: ConversationVM;
  status: StreamStatus;
  space?: SpaceInfo;
  railOpen: boolean;
  panelOpen: boolean;
  onExpandRail: () => void;
  onTogglePanel: () => void;
  onCompact: () => void;
  onReset: () => void;
}

const hbtn =
  "flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-line-strong px-2.5 text-xs font-medium text-fg-dim hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40 disabled:hover:bg-transparent";

export function SessionHeader({ bot, vm, status, space, railOpen, panelOpen, onExpandRail, onTogglePanel, onCompact, onReset }: SessionHeaderProps) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4">
      {!railOpen && (
        <button
          type="button"
          aria-label="Expand sidebar"
          title="Expand sidebar"
          onClick={onExpandRail}
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
        >
          <Icon name="sidebar" className="size-4" />
        </button>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-2 text-[13px]">
        {bot && space && (
          <>
            <span className="flex size-5 shrink-0 items-center justify-center rounded bg-brand text-[9px] font-bold text-white" aria-hidden="true">
              {space.sandbox === "e2b" ? "E2" : space.sandbox === "instabox" ? "IB" : "SP"}
            </span>
            <span className="min-w-0 max-w-40 shrink truncate text-fg-muted">{space.name ?? "sandbox"}</span>
            <span className="text-fg-faint" aria-hidden="true">
              /
            </span>
          </>
        )}
        <h1 className="truncate font-semibold text-white">{bot ? bot.name : "pi-cloud-agents"}</h1>
      </div>
      {status !== "open" && bot && (
        <span role="status" className="shrink-0 whitespace-nowrap text-xs text-warn">
          {status === "reconnecting" ? "Reconnecting…" : status === "connecting" ? "Connecting…" : "Disconnected"}
        </span>
      )}
      {vm.compacting > 0 && <span className="text-xs text-fg-muted">Compacting…</span>}
      <UsageBadge usage={vm.usage} />
      <button type="button" className={hbtn} disabled={!bot || vm.busy} onClick={onCompact}>
        Compact
      </button>
      <button type="button" className={hbtn} disabled={!bot} onClick={onReset}>
        Reset
      </button>
      <button
        type="button"
        aria-label="Toggle side panel"
        aria-pressed={panelOpen}
        title="Toggle side panel"
        onClick={onTogglePanel}
        className={`flex size-8 shrink-0 items-center justify-center rounded-lg hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent ${panelOpen ? "text-fg" : "text-fg-muted"}`}
      >
        <Icon name="panelRight" className="size-4" />
      </button>
    </header>
  );
}
