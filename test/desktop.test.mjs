import { test } from "node:test";
import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, MemoryStorage } from "@earendil-works/pi-durable";
import { openHarness, ctx } from "../src/harness.mjs";
import { BotRegistry } from "../src/bots.mjs";
import {
  Desktop,
  DRIVER_MAP,
  MAX_ELEMENTS_CHARS,
  clickArgs,
  createDesktopTools,
  formatElements,
  keyCall,
  launchArgs,
  scrollArgs,
  typeArgs,
} from "../src/ext/desktop.mjs";

/** Mock callDriver: records calls, replies from `replies[tool]` or a default ok text. */
function mock(replies = {}) {
  const calls = [];
  const callDriver = async (tool, args) => {
    calls.push({ tool, args });
    const r = replies[tool];
    if (r instanceof Error) throw r;
    return { isError: false, text: "ok", content: [], structured: undefined, ...(typeof r === "function" ? r(args) : r) };
  };
  return { calls, callDriver };
}

const byName = (tools) => Object.fromEntries(tools.map((t) => [t.name, t]));
const API = {};

test("tool names and replay flags", () => {
  const tools = byName(createDesktopTools({ callDriver: mock().callDriver }));
  assert.deepEqual(Object.keys(tools).sort(), [
    "desktop_click", "desktop_elements", "desktop_key", "desktop_launch",
    "desktop_screenshot", "desktop_scroll", "desktop_type", "desktop_windows",
  ]);
  for (const n of ["desktop_screenshot", "desktop_elements", "desktop_windows"]) assert.equal(tools[n].replay, "safe", n);
  for (const n of ["desktop_launch", "desktop_click", "desktop_type", "desktop_key", "desktop_scroll"]) assert.equal(tools[n].replay, undefined, n);
});

test("Desktop extension shape", () => {
  assert.equal(Desktop.name, "tarsbot.desktop");
  assert.equal(Desktop.tools.length, 8);
  assert.equal(Desktop.sections.length, 1);
  assert.equal(Desktop.sections[0].key, "desktop");
  const text = Desktop.sections[0].render({}, ctx);
  assert.match(String(text), /element_token/);
  assert.match(String(text), /desktop_screenshot/);
});

test("desktop_screenshot: image + text with capture_id, default dimension", async () => {
  const m = mock({
    get_desktop_state: {
      text: "Desktop screenshot 1024x640\nVisible windows: pid=1 window_id=2",
      content: [{ type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: "x" }],
      structured: { capture_id: "capture_abc" },
    },
  });
  const t = byName(createDesktopTools({ callDriver: m.callDriver }));
  const r = await t.desktop_screenshot.execute({}, API, ctx);
  assert.deepEqual(m.calls[0], { tool: DRIVER_MAP.screenshot, args: { max_image_dimension: 1024 } });
  assert.deepEqual(r.content[0], { type: "image", data: "AAAA", mimeType: "image/png" });
  assert.equal(r.content[1].type, "text");
  assert.match(r.content[1].text, /window_id=2/);
  assert.match(r.content[1].text, /capture_id: capture_abc/);
  await t.desktop_screenshot.execute({ max_image_dimension: 640 }, API, ctx);
  assert.equal(m.calls[1].args.max_image_dimension, 640);
});

test("desktop_windows maps to list_windows on_screen_only", async () => {
  const m = mock({ list_windows: { text: "Found 1 windows:\n window_id=5 pid=9 \"Example Domain\"" } });
  const t = byName(createDesktopTools({ callDriver: m.callDriver }));
  const r = await t.desktop_windows.execute({}, API, ctx);
  assert.deepEqual(m.calls[0], { tool: "list_windows", args: { on_screen_only: true } });
  assert.match(r.content[0].text, /Example Domain/);
});

const ELS = {
  window_title: "Example Domain - Chromium", app_name: "Chromium", pid: 7, window_id: 8,
  snapshot_id: "s00000001", total_element_count: 3, returned_element_count: 3,
  elements: [
    { element_index: 0, element_token: "s00000001:0", role: "frame", label: "Example Domain - Chromium", actions: ["doDefault"], frame: { x: 0, y: 0, w: 10, h: 10 } },
    { element_index: 1, element_token: "s00000001:1", role: "panel", label: "", actions: ["doDefault", "showContextMenu"] },
    { element_index: 2, element_token: "s00000001:2", role: "entry", label: "Address and search bar", value: "https://x", actions: ["activate"], enabled: false },
  ],
};

test("formatElements lists tokens, skips unlabeled layout nodes", () => {
  const out = formatElements(ELS);
  assert.match(out, /s00000001:0 frame "Example Domain - Chromium"/);
  assert.doesNotMatch(out, /s00000001:1/);
  assert.match(out, /s00000001:2 entry "Address and search bar" = "https:\/\/x" \(disabled\)/);
  assert.equal(formatElements(undefined), undefined);
});

test("desktop_elements: args, tree text, optional screenshot", async () => {
  const m = mock({ get_window_state: { text: "md", structured: ELS, content: [{ type: "image", data: "IMG", mimeType: "image/png" }] } });
  const t = byName(createDesktopTools({ callDriver: m.callDriver }));
  const r = await t.desktop_elements.execute({ pid: 7, window_id: 8, query: "addr" }, API, ctx);
  assert.deepEqual(m.calls[0].args, { pid: 7, window_id: 8, query: "addr", include_accessibility_tree: true, include_screenshot: false });
  assert.match(r.content.at(-1).text, /s00000001:2 entry/);
  await t.desktop_elements.execute({ pid: 7, window_id: 8, screenshot: true }, API, ctx);
  assert.equal(m.calls[1].args.include_screenshot, true);
});

test("desktop_elements truncates to ~12k chars", async () => {
  const elements = Array.from({ length: 2000 }, (_, i) => ({ element_index: i, element_token: `s1:${i}`, role: "link", label: `Link number ${i}`, actions: ["click"] }));
  const m = mock({ get_window_state: { structured: { ...ELS, elements } } });
  const t = byName(createDesktopTools({ callDriver: m.callDriver }));
  const r = await t.desktop_elements.execute({ pid: 1, window_id: 2 }, API, ctx);
  const txt = r.content.at(-1).text;
  assert.ok(txt.length < MAX_ELEMENTS_CHARS + 200, `len ${txt.length}`);
  assert.match(txt, /truncated/);
});

test("desktop_elements falls back to driver text without structured elements", async () => {
  const m = mock({ get_window_state: { text: "- [0] frame", structured: undefined } });
  const t = byName(createDesktopTools({ callDriver: m.callDriver }));
  const r = await t.desktop_elements.execute({ pid: 1, window_id: 2 }, API, ctx);
  assert.equal(r.content.at(-1).text, "- [0] frame");
});

test("launchArgs: name+urls passes URLs as arguments; urls alone uses urls", () => {
  assert.deepEqual(launchArgs({ name: "chromium", urls: ["https://example.com"] }), { name: "chromium", additional_arguments: ["https://example.com"] });
  assert.deepEqual(launchArgs({ urls: ["https://example.com"] }), { urls: ["https://example.com"] });
  assert.deepEqual(launchArgs({ launch_path: "/usr/bin/chromium", args: ["--incognito"] }), { launch_path: "/usr/bin/chromium", additional_arguments: ["--incognito"] });
  assert.deepEqual(launchArgs({ name: "firefox" }), { name: "firefox" });
});

test("clickArgs: element_token wins; window x/y; desktop scope; double; button", () => {
  assert.deepEqual(clickArgs({ pid: 1, window_id: 2, element_token: "s1:3", x: 5, y: 6 }), { pid: 1, element_token: "s1:3" });
  assert.deepEqual(clickArgs({ window_id: 2, pid: 1, x: 5, y: 6 }), { pid: 1, window_id: 2, x: 5, y: 6 });
  assert.deepEqual(clickArgs({ scope: "desktop", x: 100, y: 50 }), { scope: "desktop", x: 100, y: 50 });
  assert.deepEqual(clickArgs({ x: 100, y: 50 }), { scope: "desktop", x: 100, y: 50 });
  assert.deepEqual(clickArgs({ pid: 1, element_token: "s1:3", double: true, button: "right" }), { pid: 1, element_token: "s1:3", button: "right", count: 2 });
  assert.equal(clickArgs({ pid: 1, window_id: 2, x: 1, y: 1, button: "left" }).button, undefined);
});

test("typeArgs / scrollArgs: targeting and desktop fallback", () => {
  assert.deepEqual(typeArgs({ pid: 1, element_token: "s1:3", text: "hi" }), { pid: 1, element_token: "s1:3", text: "hi" });
  assert.deepEqual(typeArgs({ text: "hi" }), { text: "hi", scope: "desktop" });
  assert.deepEqual(scrollArgs({ pid: 1, window_id: 2, direction: "down", amount: 5 }), { pid: 1, window_id: 2, direction: "down", amount: 5 });
  assert.deepEqual(scrollArgs({ direction: "up" }), { direction: "up", scope: "desktop" });
});

test("keyCall: keys -> hotkey, key -> press_key", () => {
  assert.deepEqual(keyCall({ pid: 1, keys: ["ctrl", "l"] }), ["hotkey", { pid: 1, keys: ["ctrl", "l"] }]);
  assert.deepEqual(keyCall({ pid: 1, window_id: 2, key: "enter" }), ["press_key", { pid: 1, window_id: 2, key: "enter" }]);
  assert.deepEqual(keyCall({ key: "tab", modifiers: ["shift"] }), ["press_key", { scope: "desktop", key: "tab", modifiers: ["shift"] }]);
  assert.throws(() => keyCall({ pid: 1 }), /key/);
});

test("action tools call the mapped driver tools", async () => {
  const m = mock();
  const t = byName(createDesktopTools({ callDriver: m.callDriver }));
  await t.desktop_launch.execute({ name: "chromium", urls: ["https://example.com"] }, API, ctx);
  await t.desktop_click.execute({ pid: 1, element_token: "s1:3" }, API, ctx);
  await t.desktop_type.execute({ pid: 1, element_token: "s1:3", text: "hello" }, API, ctx);
  await t.desktop_key.execute({ pid: 1, keys: ["ctrl", "a"] }, API, ctx);
  await t.desktop_key.execute({ pid: 1, key: "enter" }, API, ctx);
  await t.desktop_scroll.execute({ pid: 1, direction: "down" }, API, ctx);
  assert.deepEqual(m.calls.map((c) => c.tool), ["launch_app", "click", "type_text", "hotkey", "press_key", "scroll"]);
});

test("input tools default to foreground delivery (Chromium needs it); overridable", async () => {
  const m = mock();
  const t = byName(createDesktopTools({ callDriver: m.callDriver }));
  await t.desktop_click.execute({ pid: 1, element_token: "s1:3" }, API, ctx);
  await t.desktop_type.execute({ pid: 1, text: "a" }, API, ctx);
  await t.desktop_key.execute({ pid: 1, key: "enter", delivery_mode: "background" }, API, ctx);
  await t.desktop_scroll.execute({ pid: 1, direction: "down" }, API, ctx);
  assert.deepEqual(m.calls.map((c) => c.args.delivery_mode), ["foreground", "foreground", "background", "foreground"]);
  await t.desktop_windows.execute({}, API, ctx);
  assert.equal(m.calls.at(-1).args.delivery_mode, undefined);
});

test("driver isError and thrown errors become tool errors containing the driver text", async () => {
  const m = mock({ click: { isError: true, text: "stale element_token" }, type_text: new Error("socket closed") });
  const t = byName(createDesktopTools({ callDriver: m.callDriver }));
  await assert.rejects(t.desktop_click.execute({ pid: 1, element_token: "s1:1" }, API, ctx), /click failed: stale element_token/);
  await assert.rejects(t.desktop_type.execute({ pid: 1, text: "x" }, API, ctx), /socket closed/);
});

test("end to end through the harness: faux model calls desktop tools (mock driver)", async () => {
  const m = mock({ list_windows: { text: "Found 1 windows: Example Domain" } });
  const Ext = defineExtension({ name: "test.desktop", tools: createDesktopTools({ callDriver: m.callDriver }) });
  const f = fauxProvider();
  const models = createModels();
  models.setProvider(f.provider);
  f.setResponses([
    fauxAssistantMessage([fauxToolCall("desktop_windows", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("desktop_click", { pid: 3, element_token: "s1:9" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("done")]),
  ]);
  const { harness } = await openHarness({ storage: new MemoryStorage(), models, extensions: [Ext] });
  const bots = new BotRegistry(harness, { path: null });
  const bot = await bots.createBot({ name: "d1", model: { provider: "faux", modelId: "faux-1" } });
  const conv = await bots.conversation(bot.id);
  const settled = await (await conv.submit({ type: "input", content: "look" }, ctx)).wait(ctx);
  assert.equal(settled.status, "done");
  assert.deepEqual(m.calls, [
    { tool: "list_windows", args: { on_screen_only: true } },
    { tool: "click", args: { pid: 3, element_token: "s1:9", delivery_mode: "foreground" } },
  ]);
  await harness.close(ctx);
});
