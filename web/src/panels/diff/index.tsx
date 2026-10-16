import { turnChanges } from "../../lib/turns";
import type { PanelDefinition } from "../types";
import { DiffPanel } from "./DiffPanel";

export const diffPanel: PanelDefinition = {
  id: "diff",
  title: "Changes",
  icon: "diff",
  Component: DiffPanel,
  badge: (ctx) => {
    const n = turnChanges(ctx.vm.messages, { busy: ctx.vm.busy }).reduce((s, t) => s + t.files.length, 0);
    return n > 0 ? n : undefined;
  },
};
