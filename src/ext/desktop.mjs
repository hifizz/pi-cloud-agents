// Desktop tools: let a Bot see and operate the Space's Linux desktop through Cua Driver (REQ-F02).
// Tool names are fixed; driver tool names / parameter conversion are centralized in DRIVER_MAP.
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { callDriver as defaultCallDriver } from "../space.mjs";

/** Our tool -> driver tool name. Rename here if the driver changes. */
export const DRIVER_MAP = {
  screenshot: "get_desktop_state",
  elements: "get_window_state",
  windows: "list_windows",
  launch: "launch_app",
  click: "click",
  type: "type_text",
  hotkey: "hotkey",
  key: "press_key",
  scroll: "scroll",
};

export const MAX_ELEMENTS_CHARS = 12_000;
export const DEFAULT_SCREENSHOT_DIMENSION = 1024;
/**
 * Measured: Chromium rejects "background" input ("Background delivery is not available ... Retry with
 * delivery_mode:foreground"). The desktop is a dedicated Space, so a focus swap is harmless: default to foreground.
 */
export const DEFAULT_DELIVERY_MODE = "foreground";

const withDelivery = (dargs, a) => ({ ...dargs, delivery_mode: a.delivery_mode ?? DEFAULT_DELIVERY_MODE });

const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

function truncate(text, max = MAX_ELEMENTS_CHARS) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated: ${text.length - max} more chars; use the query parameter to narrow the result]`;
}

// ── Argument conversion (pure; unit-tested) ─────────────────────────────────

/** Target fields shared by input tools. Without pid/window_id/element_token the action goes to the desktop frame. */
function target(a) {
  const t = defined({ pid: a.pid, window_id: a.window_id, element_token: a.element_token });
  return t;
}

export function screenshotArgs(a = {}) {
  return { max_image_dimension: a.max_image_dimension ?? DEFAULT_SCREENSHOT_DIMENSION };
}

export function elementsArgs(a) {
  return defined({
    pid: a.pid,
    window_id: a.window_id,
    query: a.query || undefined,
    include_accessibility_tree: true,
    include_screenshot: a.screenshot === true,
    max_image_dimension: a.screenshot === true ? DEFAULT_SCREENSHOT_DIMENSION : undefined,
  });
}

export function windowsArgs() {
  return { on_screen_only: true };
}

/**
 * launch_app. Measured: `urls` alone goes through xdg-open (opens the default browser, Firefox); with a name or
 * launch_path we pass the URLs as command-line arguments so `name:"chromium"` really opens Chromium.
 */
export function launchArgs(a) {
  const urls = a.urls?.length ? a.urls : undefined;
  const extra = [...(a.args ?? [])];
  if (a.name || a.launch_path) {
    return defined({
      name: a.launch_path ? undefined : a.name,
      launch_path: a.launch_path,
      additional_arguments: [...extra, ...(urls ?? [])].length ? [...extra, ...(urls ?? [])] : undefined,
    });
  }
  return defined({ urls, additional_arguments: extra.length ? extra : undefined });
}

/** click: element_token wins (pid + token); otherwise x/y. No pid/window_id means desktop screenshot coordinates. */
export function clickArgs(a) {
  const out = target(a);
  if (a.element_token) {
    delete out.window_id; // the token carries it
  } else {
    if (a.x !== undefined) out.x = a.x;
    if (a.y !== undefined) out.y = a.y;
    if (a.scope === "desktop" || (a.pid === undefined && a.window_id === undefined)) out.scope = "desktop";
    if (a.scope === "desktop" && a.window_id !== undefined) out.coordinate_frame = "desktop";
  }
  if (a.button && a.button !== "left") out.button = a.button;
  if (a.double) out.count = 2;
  return out;
}

export function typeArgs(a) {
  const out = { ...target(a), text: a.text };
  if (a.pid === undefined && a.window_id === undefined && !a.element_token) out.scope = "desktop";
  return out;
}

/** `keys` array -> hotkey; otherwise `key` (+ optional modifiers) -> press_key. Returns [driverTool, args]. */
export function keyCall(a) {
  const base = target(a);
  if (a.pid === undefined && a.window_id === undefined && !a.element_token) base.scope = "desktop";
  if (a.keys?.length) return [DRIVER_MAP.hotkey, { ...base, keys: a.keys }];
  if (!a.key) throw new Error("desktop_key needs `key` (e.g. \"enter\") or `keys` (e.g. [\"ctrl\",\"l\"])");
  return [DRIVER_MAP.key, defined({ ...base, key: a.key, modifiers: a.modifiers?.length ? a.modifiers : undefined })];
}

export function scrollArgs(a) {
  const out = { ...target(a), direction: a.direction };
  if (a.amount !== undefined) out.amount = a.amount;
  if (a.x !== undefined) out.x = a.x;
  if (a.y !== undefined) out.y = a.y;
  if (a.pid === undefined && a.window_id === undefined && !a.element_token) out.scope = "desktop";
  return out;
}

// ── Result conversion ───────────────────────────────────────────────────────

function textOf(r) {
  if (r.text) return r.text;
  return (r.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function images(r) {
  return (r.content ?? [])
    .filter((c) => c.type === "image" && c.data)
    .map((c) => ({ type: "image", data: c.data, mimeType: c.mimeType ?? "image/png" }));
}

/** Compact element listing with tokens, which the driver's markdown omits. Skips unlabeled layout nodes. */
export function formatElements(structured) {
  const els = structured?.elements;
  if (!Array.isArray(els)) return undefined;
  const PLAIN = new Set(["doDefault", "showContextMenu"]);
  const lines = [];
  for (const e of els) {
    const interactive = (e.actions ?? []).some((x) => !PLAIN.has(x));
    if (!e.label && !e.value && !interactive) continue;
    let line = `${e.element_token ?? `#${e.element_index}`} ${e.role}`;
    if (e.label) line += ` "${e.label}"`;
    if (e.value) line += ` = ${JSON.stringify(e.value)}`;
    if (e.enabled === false) line += " (disabled)";
    if (e.selected) line += " (selected)";
    if (e.frame) line += ` @${e.frame.x},${e.frame.y} ${e.frame.w}x${e.frame.h}`;
    lines.push(line);
  }
  return lines.join("\n");
}

async function run(callDriver, tool, args, opts) {
  let r;
  try {
    r = await callDriver(tool, args, opts);
  } catch (e) {
    throw new Error(`${tool} failed: ${e?.message ?? e}`);
  }
  if (r.isError) throw new Error(`${tool} failed: ${textOf(r) || "(no detail)"}`);
  return r;
}

const text = (t) => ({ type: "text", text: t });

// ── Tool factory ────────────────────────────────────────────────────────────

const Pid = Type.Optional(Type.Integer({ description: "Process id (pid) from desktop_screenshot / desktop_windows." }));
const WindowId = Type.Optional(Type.Integer({ description: "Window id from desktop_screenshot / desktop_windows." }));
const Delivery = Type.Optional(
  Type.Union([Type.Literal("foreground"), Type.Literal("background")], {
    description: "Default \"foreground\" (activates the window first; required for Chromium). \"background\" sends input without raising the window.",
  }),
);
const Token = Type.Optional(
  Type.String({ description: "element_token from desktop_elements (e.g. \"s00000001:13\"). Preferred over x/y. Stale after the next desktop_elements of the same window." }),
);

export function createDesktopTools({ callDriver = defaultCallDriver } = {}) {
  const screenshot = defineTool({
    name: "desktop_screenshot",
    description:
      "Take a screenshot of the whole desktop (your Linux computer). Returns the image plus the list of visible windows with their pid and window_id, and a capture_id. " +
      "x/y given to desktop_click with no pid/window_id are pixels of THIS screenshot. Use it to see the state and to verify an action worked.",
    parameters: Type.Object({
      max_image_dimension: Type.Optional(
        Type.Integer({ minimum: 0, description: `Long-edge cap of the image in pixels. Default ${DEFAULT_SCREENSHOT_DIMENSION}; 0 = full size.` }),
      ),
    }),
    replay: "safe",
    async execute(args) {
      const r = await run(callDriver, DRIVER_MAP.screenshot, screenshotArgs(args));
      const capture = r.structured?.capture_id;
      const head = textOf(r);
      return { content: [...images(r), text(capture ? `${head}\ncapture_id: ${capture}` : head)] };
    },
  });

  const elements = defineTool({
    name: "desktop_elements",
    description:
      "List the accessible (AT-SPI) UI elements of one window: role, label, value, and an element_token for each. " +
      "Pass a token to desktop_click / desktop_type / desktop_key — this is more reliable than pixel coordinates. " +
      "Use `query` (case-insensitive substring) to narrow large windows such as web pages. Tokens expire when you call this again for the same window.",
    parameters: Type.Object({
      pid: Type.Integer({ description: "Process id that owns the window." }),
      window_id: Type.Integer({ description: "Window id." }),
      query: Type.Optional(Type.String({ description: "Only return elements whose text matches, plus their ancestors." })),
      screenshot: Type.Optional(Type.Boolean({ description: "Also return a screenshot of the window. Default false." })),
    }),
    replay: "safe",
    async execute(args) {
      const r = await run(callDriver, DRIVER_MAP.elements, elementsArgs(args));
      const s = r.structured;
      const list = formatElements(s);
      const head = s
        ? `window "${s.window_title ?? ""}" (${s.app_name ?? "?"}) pid=${s.pid ?? args.pid} window_id=${s.window_id ?? args.window_id}; ` +
          `${s.returned_element_count ?? s.element_count ?? "?"}/${s.total_element_count ?? "?"} elements; snapshot ${s.snapshot_id ?? "?"}. ` +
          `Format: element_token role "label" = value @x,y wxh (window-local pixels).`
        : "";
      const body = list !== undefined ? `${head}\n${list || "(no labeled or interactive elements)"}` : textOf(r);
      return { content: [...images(r), text(truncate(body))] };
    },
  });

  const windows = defineTool({
    name: "desktop_windows",
    description: "List the visible top-level windows: window_id, pid, title, size and position, app name. Use it to find a window or check a page title.",
    parameters: Type.Object({}),
    replay: "safe",
    async execute() {
      const r = await run(callDriver, DRIVER_MAP.windows, windowsArgs());
      return { content: [text(textOf(r))] };
    },
  });

  const launch = defineTool({
    name: "desktop_launch",
    description:
      "Launch an application on the desktop. Examples: {name:\"chromium\", urls:[\"https://example.com\"]} opens Chromium on that page; " +
      "{name:\"firefox\"}; {launch_path:\"/usr/bin/chromium\"}. With only `urls` the system default browser (Firefox) opens them. " +
      "The window takes a few seconds to appear: wait, then call desktop_windows or desktop_screenshot.",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "App name or command, e.g. \"chromium\", \"firefox\", \"xfce4-terminal\"." })),
      launch_path: Type.Optional(Type.String({ description: "Launcher command or path (from the app list)." })),
      urls: Type.Optional(Type.Array(Type.String(), { description: "URLs to open." })),
      args: Type.Optional(Type.Array(Type.String(), { description: "Extra command-line arguments." })),
    }),
    async execute(args) {
      const r = await run(callDriver, DRIVER_MAP.launch, launchArgs(args));
      return { content: [text(textOf(r))] };
    },
  });

  const click = defineTool({
    name: "desktop_click",
    description:
      "Click. Preferred: {pid, element_token} from desktop_elements. Otherwise {window_id, x, y} in window-local pixels, " +
      "or {scope:\"desktop\", x, y} in desktop_screenshot pixels. Set double:true to double-click; button \"right\" opens context menus.",
    parameters: Type.Object({
      pid: Pid,
      window_id: WindowId,
      element_token: Token,
      delivery_mode: Delivery,
      x: Type.Optional(Type.Number({ description: "X pixel (window-local, or desktop screenshot pixels with scope \"desktop\")." })),
      y: Type.Optional(Type.Number({ description: "Y pixel." })),
      scope: Type.Optional(Type.Union([Type.Literal("window"), Type.Literal("desktop")], { description: "\"desktop\": x/y are desktop screenshot pixels." })),
      button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
      double: Type.Optional(Type.Boolean({ description: "Double-click." })),
    }),
    async execute(args) {
      const r = await run(callDriver, DRIVER_MAP.click, withDelivery(clickArgs(args), args));
      return { content: [...images(r), text(textOf(r) || "clicked")] };
    },
  });

  const type = defineTool({
    name: "desktop_type",
    description:
      "Type text. Give {pid, element_token} to type into a specific field (preferred), or {pid, window_id} for the window's focused field. " +
      "With no target the text goes to the focused application. Use desktop_key for Enter, Tab and shortcuts.",
    parameters: Type.Object({
      pid: Pid,
      window_id: WindowId,
      element_token: Token,
      delivery_mode: Delivery,
      text: Type.String({ description: "Text to type." }),
    }),
    async execute(args) {
      const r = await run(callDriver, DRIVER_MAP.type, withDelivery(typeArgs(args), args));
      return { content: [text(textOf(r) || "typed")] };
    },
  });

  const key = defineTool({
    name: "desktop_key",
    description:
      "Press a key or shortcut. Single key: {key:\"enter\"} (also tab, escape, backspace, up, down, pageup, f5 …; optional modifiers:[\"ctrl\"]). " +
      "Shortcut: {keys:[\"ctrl\",\"l\"]} (modifiers first, one non-modifier last). Target with pid (+ window_id / element_token); with no target it goes to the focused application.",
    parameters: Type.Object({
      pid: Pid,
      window_id: WindowId,
      element_token: Token,
      delivery_mode: Delivery,
      key: Type.Optional(Type.String({ description: "Key name, e.g. \"enter\", \"tab\", \"escape\", or one character." })),
      modifiers: Type.Optional(Type.Array(Type.String(), { description: "With `key`: ctrl, shift, alt, super." })),
      keys: Type.Optional(Type.Array(Type.String(), { minItems: 2, description: "Shortcut chord, e.g. [\"ctrl\",\"c\"]." })),
    }),
    async execute(args) {
      const [tool, dargs] = keyCall(args);
      const r = await run(callDriver, tool, withDelivery(dargs, args));
      return { content: [text(textOf(r) || "key sent")] };
    },
  });

  const scroll = defineTool({
    name: "desktop_scroll",
    description: "Scroll a window (direction up/down/left/right, amount 1–50 steps, default 3). Target with pid (+ window_id); x/y optionally choose the scroll position.",
    parameters: Type.Object({
      pid: Pid,
      window_id: WindowId,
      element_token: Token,
      delivery_mode: Delivery,
      direction: Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")]),
      amount: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Scroll steps. Default 3." })),
      x: Type.Optional(Type.Number()),
      y: Type.Optional(Type.Number()),
    }),
    async execute(args) {
      const r = await run(callDriver, DRIVER_MAP.scroll, withDelivery(scrollArgs(args), args));
      return { content: [text(textOf(r) || "scrolled")] };
    },
  });

  return [screenshot, elements, windows, launch, click, type, key, scroll];
}

export const DESKTOP_GUIDE = `You have a Linux desktop (XFCE) you can see and operate with the desktop_* tools.
1. Start with desktop_screenshot or desktop_windows to get pid and window_id of the window you need. Launch apps with desktop_launch (e.g. name "chromium" with urls); wait a few seconds, then look again.
2. Call desktop_elements(pid, window_id, query?) to get element_token values. Prefer acting by element_token (desktop_click / desktop_type / desktop_key) over pixel coordinates; use x/y only for canvas-like surfaces that have no accessible elements.
3. Tokens expire when you call desktop_elements again for the same window — re-read before acting after the page changes.
4. After each action, verify with desktop_screenshot or desktop_elements before you go on or report success.`;

export const Desktop = defineExtension({
  name: "tarsbot.desktop",
  tools: createDesktopTools(),
  sections: [section("desktop", () => DESKTOP_GUIDE)],
});
