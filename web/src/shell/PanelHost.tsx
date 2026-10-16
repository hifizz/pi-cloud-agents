// Right-hand panel host: tab strip + the active panel's body. Knows nothing about specific panels.
import type { PanelContext, PanelDefinition, PanelFocus } from "../panels/types";
import { cx } from "../lib/cx";
import { Icon } from "../components/Chat/primitives/Icon";

export interface PanelHostProps {
  panels: PanelDefinition[];
  active: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  ctx: PanelContext;
  /** Pending focus request; passed only to the panel it was addressed to (see usePanelState). */
  focus?: PanelFocus;
}

export function PanelHost({ panels, active, onSelect, onClose, ctx, focus }: PanelHostProps) {
  const current = panels.find((p) => p.id === active) ?? panels[0];
  const panelCtx: PanelContext = { ...ctx, focus: focus ?? ctx.focus };
  const Body = current?.Component;
  return (
    <>
      <div className="flex h-14 shrink-0 items-center gap-1 border-b border-line px-3">
        <div role="tablist" aria-label="Panels" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {panels.map((p) => {
            const selected = p.id === current?.id;
            const badge = p.badge?.(ctx);
            return (
              <button
                key={p.id}
                type="button"
                role="tab"
                id={`panel-tab-${p.id}`}
                aria-selected={selected}
                aria-controls="panel-body"
                onClick={() => onSelect(p.id)}
                className={cx(
                  "flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                  selected ? "border-[#242424] bg-[#161616] text-fg" : "border-transparent text-fg-muted hover:text-fg-dim",
                )}
              >
                <Icon name={p.icon} className="size-3.5" />
                {p.title}
                {badge !== undefined && badge !== "" && (
                  <span className="rounded-full bg-[#222] px-1.5 text-[10.5px] leading-[16px] text-fg-dim">{badge}</span>
                )}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          aria-label="Close panel"
          title="Close panel"
          onClick={onClose}
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
        >
          <Icon name="panelRight" className="size-4" />
        </button>
      </div>
      <div role="tabpanel" id="panel-body" aria-labelledby={current ? `panel-tab-${current.id}` : undefined} className="min-h-0 flex-1 overflow-hidden">
        {Body && <Body {...panelCtx} />}
      </div>
    </>
  );
}
