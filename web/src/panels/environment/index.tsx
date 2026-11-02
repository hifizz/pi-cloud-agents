import { EnvironmentPane } from "../../components/EnvironmentPane";
import { ScrollArea } from "../../components/ui/scroll-area";
import type { PanelDefinition } from "../types";

export const environmentPanel: PanelDefinition = {
  id: "environment",
  title: "Environment",
  icon: "box",
  Component: ({ bot, vm }) => (
    <ScrollArea className="h-full">
      <EnvironmentPane bot={bot} vm={vm} />
    </ScrollArea>
  ),
};
