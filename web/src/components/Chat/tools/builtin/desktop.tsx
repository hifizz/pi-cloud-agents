import type { ToolPart } from "../../../../types";
import { clip } from "../../../../lib/format";
import { argNum, argStr, type ToolRenderer } from "../types";
import { ResultOutput } from "./generic";

// Desktop (Cua driver) tools. They share one body: the result text, with screenshots handled by the frame.
const target = (t: ToolPart): string => {
  const token = argStr(t, "element_token");
  if (token) return `element ${token}`;
  const x = argNum(t, "x");
  const y = argNum(t, "y");
  if (x !== undefined && y !== undefined) return `(${Math.round(x)}, ${Math.round(y)})`;
  const pid = argNum(t, "pid");
  return pid !== undefined ? `pid ${pid}` : "";
};

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function make(icon: ToolRenderer["icon"], title: string, detail?: ToolRenderer["detail"]): ToolRenderer {
  return { icon, title, detail, Body: ({ tool }) => <ResultOutput tool={tool} /> };
}

export const desktopTools: Record<string, ToolRenderer> = {
  desktop_screenshot: make("camera", "Screenshot"),
  desktop_elements: make("tree", "Inspect UI", (t) => [target(t), argStr(t, "query")].filter(Boolean).join(" · ")),
  desktop_windows: make("window", "List windows"),
  desktop_launch: make("play", "Launch", (t) => argStr(t, "name") ?? argStr(t, "launch_path") ?? list(t.args.urls).join(", ")),
  desktop_click: make("pointer", "Click", (t) => {
    const flags = [t.args.double ? "double" : "", argStr(t, "button") && argStr(t, "button") !== "left" ? argStr(t, "button") : ""].filter(Boolean);
    return [target(t), ...flags].join(" · ");
  }),
  desktop_type: make("keyboard", "Type", (t) => clip(JSON.stringify(argStr(t, "text") ?? ""), 80)),
  desktop_key: make("keyboard", "Press key", (t) => {
    const keys = list(t.args.keys);
    return keys.length ? keys.join("+") : [...list(t.args.modifiers), argStr(t, "key") ?? ""].filter(Boolean).join("+");
  }),
  desktop_scroll: make("arrowDown", "Scroll", (t) => [argStr(t, "direction"), argNum(t, "amount") && `×${argNum(t, "amount")}`].filter(Boolean).join(" ")),
};
