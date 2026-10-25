// Loop guard (bdots guards.ts idea 1): a beforeTool hook that blocks a tool call when the SAME tool with the SAME
// arguments (recursively key-sorted) is repeated too many times in a row. Blocking is better than failing the run:
// the model gets a message telling it to stop and explain, so it can change approach.
//
// State is per tool task (the api.taskId memo survives restarts), so the counter never leaks across unrelated calls.
// Only consecutive identical calls count: any different call in between resets the chain.
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";

export const DEFAULT_MAX_REPEATS = 5;
const MEMO = "tarsbot.loopGuard";

/** Stable JSON with object keys sorted recursively, so {a:1,b:2} === {b:2,a:1}. */
export function stableKey(value) {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableKey(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Track consecutive identical calls per tool name.
 * @returns {{ seen: (name: string, key: string) => number, reset: (name: string) => void }}
 */
export function createRepeatTracker() {
  const counts = new Map(); // `${name}\u0000${key}` -> consecutive count
  return {
    seen(name, key) {
      const k = `${name}\u0000${key}`;
      const n = (counts.get(k) ?? 0) + 1;
      counts.set(k, n);
      for (const other of counts.keys()) {
        if (other !== k && other.split("\u0000")[0] === name) counts.delete(other);
      }
      return n;
    },
    reset(name) {
      for (const k of [...counts.keys()]) if (k.split("\u0000")[0] === name) counts.delete(k);
    },
  };
}

/**
 * @param {{ maxRepeats?: number }} [opts]
 */
export function createLoopGuard(opts = {}) {
  const max = opts.maxRepeats ?? DEFAULT_MAX_REPEATS;
  const tracker = createRepeatTracker();
  return defineExtension({
    name: "tarsbot.loopGuard",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, _api, _context) => {
          const name = String(call?.name ?? "");
          const key = stableKey(call?.arguments ?? {});
          const n = tracker.seen(name, key);
          if (n <= max) return undefined;
          tracker.reset(name);
          return {
            block:
              `You have called ${name} with the exact same arguments ${n} times in a row and it did not help. ` +
              "Stop repeating it. Explain what you are trying to achieve and why it keeps failing, then try a " +
              "different approach or ask the user.",
          };
        },
      }),
    ],
  });
}

export const LoopGuard = createLoopGuard();
