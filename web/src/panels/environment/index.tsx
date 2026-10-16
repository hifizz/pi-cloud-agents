import { EnvironmentPane } from "../../components/EnvironmentPane";
import type { PanelDefinition } from "../types";

export const environmentPanel: PanelDefinition = {
  id: "environment",
  title: "Environment",
  icon: "box",
  Component: ({ space, spaceFailed, bot, vm }) => (
    <div className="h-full overflow-y-auto">
      <EnvironmentPane space={space} failed={spaceFailed} bot={bot} vm={vm} />
    </div>
  ),
};
