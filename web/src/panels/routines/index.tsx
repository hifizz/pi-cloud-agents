import { RoutinesPanel } from "../../components/RoutinesPanel";
import { ScrollArea } from "../../components/ui/scroll-area";
import type { PanelDefinition } from "../types";

export const routinesPanel: PanelDefinition = {
  id: "routines",
  title: "Routines",
  icon: "clock",
  Component: ({ bots }) => (
    <ScrollArea className="h-full">
      <RoutinesPanel bots={bots} embedded />
    </ScrollArea>
  ),
};
