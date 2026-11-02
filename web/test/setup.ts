import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { setMockViewportWidth } from "./helpers/viewport";

// jsdom lacks matchMedia and ResizeObserver; the resizable shell needs both. The matchMedia mock
// resolves `(min-width: Npx)` / `(max-width: Npx)` against a controllable width (default 1024, the
// jsdom viewport) so tests can drive the md/xl breakpoints via setMockViewportWidth.
const listeners = new Set<EventListenerOrEventListenerObject>();
const resolve = (query: string): boolean => {
  const width = globalThis.innerWidth;
  const min = /\(min-width:\s*(\d+)px\)/.exec(query);
  if (min) return width >= Number(min[1]);
  const max = /\(max-width:\s*(\d+)px\)/.exec(query);
  if (max) return width <= Number(max[1]);
  return false;
};
globalThis.matchMedia = ((query: string) => ({
  matches: resolve(query),
  media: query,
  onchange: null,
  addEventListener: (_: string, cb: EventListenerOrEventListenerObject) => listeners.add(cb),
  removeEventListener: (_: string, cb: EventListenerOrEventListenerObject) => listeners.delete(cb),
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof globalThis.matchMedia;

// Notifies all matchMedia listeners that the (mock) viewport changed, so useSyncExternalStore
// re-reads `matches`. Called by setMockViewportWidth after it updates innerWidth.
export function notifyViewportChange() {
  const evt = { type: "change" } as MediaQueryListEvent;
  listeners.forEach((cb) => (typeof cb === "function" ? cb(evt) : cb.handleEvent(evt)));
}
if (typeof globalThis.ResizeObserver !== "function") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof globalThis.ResizeObserver;
}

afterEach(() => {
  cleanup();
  setMockViewportWidth(1024);
});
