// Right-side panel contract (docs/UI-PLAN.md §3). A panel is a self-contained module: it gets the
// same read-only context as every other panel and renders its own body. The shell (PanelHost) owns
// the tab strip, open/close and which panel is active; panels never import each other.
// To add, remove, reorder or replace a panel, edit the PANELS list in ./index.ts — nothing else.
import type { ComponentType } from "react";
import type { IconName } from "../components/Chat/primitives/Icon";
import type { BotSummary, ConversationVM, SpaceInfo } from "../types";

/** A request to show something specific, e.g. "Open diff" on turn X / file Y. `seq` changes on every request. */
export interface PanelFocus {
  turnKey?: string;
  path?: string;
  seq: number;
}

export interface PanelContext {
  /** Selected bot, if any. */
  bot?: BotSummary;
  bots: BotSummary[];
  /** Live conversation of the selected bot (empty VM when none). */
  vm: ConversationVM;
  /** GET /api/space, once loaded. */
  space?: SpaceInfo;
  /** True when GET /api/space failed. */
  spaceFailed?: boolean;
  /** Present only for the panel the focus was addressed to. */
  focus?: PanelFocus;
}

export interface PanelDefinition {
  /** Stable id; persisted as the active tab. */
  id: string;
  /** Tab label. */
  title: string;
  icon: IconName;
  Component: ComponentType<PanelContext>;
  /** Optional small count next to the tab title (e.g. changed files). */
  badge?: (ctx: PanelContext) => string | number | undefined;
}
