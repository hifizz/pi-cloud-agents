// Test helpers: load recorded frames and build the protocol-level view at any frame boundary,
// WITHOUT using the reducer (so late-join tests compare two independent code paths).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Frame, ViewFrame, WireView } from "../src/lib/reducer";

const here = dirname(fileURLToPath(import.meta.url));

export function loadFixture(name: string): Frame[] {
  return JSON.parse(readFileSync(join(here, "fixtures", `${name}.json`), "utf8")) as Frame[];
}

export const FIXTURES = ["run-basic", "run-tool", "run-abort", "run-real"];

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Plain mutable Chord op application (independent of the reducer's immutable one). */
function applyMutable(root: any, ops: readonly any[]): any {
  for (const op of ops) {
    if (op[0] === "r") {
      root = structuredClone(op[1]);
      continue;
    }
    const path = op[1] as (string | number)[];
    if (op[0] === "p" || op[0] === "m") {
      const arr = path.reduce((node: any, k) => node[k], root);
      if (op[0] === "p") arr.splice(op[2], op[3], ...structuredClone(op[4]));
      else {
        const prev = arr.slice();
        op[2].forEach((from: number, i: number) => (arr[i] = prev[from]));
      }
      continue;
    }
    const parent = path.slice(0, -1).reduce((node: any, k) => node[k], root);
    const key = path[path.length - 1] as any;
    if (op[0] === "s") parent[key] = structuredClone(op[2]);
    else if (op[0] === "d") Array.isArray(parent) ? parent.splice(key, 1) : delete parent[key];
    else if (op[0] === "a") parent[key] += op[2];
    else if (op[0] === "t") parent[key] = parent[key].slice(op[2]);
  }
  return root;
}

/** The view a client attaching after the first `1 + count` frames would get as its first frame. */
export function viewAfter(frames: Frame[], count: number): ViewFrame {
  const first = frames[0] as ViewFrame;
  let view: WireView = structuredClone(first.view);
  for (const frame of frames.slice(1, 1 + count) as any[]) {
    if (frame.type === "ops") view = applyMutable(view, frame.ops);
  }
  return { type: "view", view };
}
