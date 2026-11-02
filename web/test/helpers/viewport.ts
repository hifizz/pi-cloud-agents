// Shared mock viewport width used by the matchMedia stub in test/setup.ts. Tests set this before
// rendering to drive the shell's md (768px) and xl (1280px) breakpoints.
import { act } from "@testing-library/react";
import { notifyViewportChange } from "../setup";

export function setMockViewportWidth(px: number) {
  Object.defineProperty(globalThis, "innerWidth", { value: px, writable: true, configurable: true });
  act(() => notifyViewportChange());
}
