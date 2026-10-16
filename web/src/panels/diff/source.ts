// Where the Changes panel gets its per-turn file changes from. Today: edit/write tool results in the
// conversation. A future git-backed source (e.g. `git diff` per commit via a backend endpoint) only has
// to implement this same interface and be passed to <DiffPanel source={…} />.
import { useMemo } from "react";
import { turnChanges, type TurnChange } from "../../lib/turns";
import type { PanelContext } from "../types";

export interface DiffSource {
  id: string;
  label: string;
  useTurns(ctx: PanelContext): { turns: TurnChange[]; loading?: boolean; error?: string };
}

export const conversationSource: DiffSource = {
  id: "conversation",
  label: "Conversation",
  useTurns(ctx) {
    const { messages, busy } = ctx.vm;
    const turns = useMemo(() => turnChanges(messages, { busy }), [messages, busy]);
    return { turns };
  },
};
