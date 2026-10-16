import { RoutinesPanel } from "../../components/RoutinesPanel";
import type { PanelDefinition } from "../types";

export const routinesPanel: PanelDefinition = {
  id: "routines",
  title: "Routines",
  icon: "clock",
  Component: ({ bots }) => (
    <div className="h-full overflow-y-auto">
      <RoutinesPanel bots={bots} embedded />
    </div>
  ),
};
