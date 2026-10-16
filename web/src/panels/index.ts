// The right-hand panels, in tab order. To add, remove, reorder or replace a panel, edit only this list
// (docs/UI-PLAN.md U-D3). Each panel lives in its own directory under panels/ and implements PanelDefinition.
import { diffPanel } from "./diff";
import { environmentPanel } from "./environment";
import { routinesPanel } from "./routines";
import type { PanelDefinition } from "./types";

export const PANELS: PanelDefinition[] = [diffPanel, environmentPanel, routinesPanel];
