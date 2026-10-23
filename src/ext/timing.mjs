// Tool execution time (wall clock), shown on the UI's tool cards.
//
// Installed after Approval, so `beforeTool` runs once a human verdict exists: time spent waiting for approval is not
// counted. The start is a durable memo (first write wins), so a tool resumed after a server restart keeps its original
// start and its duration includes the downtime. The duration is added to the result's `details`, which the harness stores
// on the tool-result message; providers never send `details` to the model.
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";

export const TIMING_KEY = "tarsbotTiming";
const START_MEMO = "tarsbot.toolStart";

/** Merge `{ [TIMING_KEY]: { durationMs } }` into details; non-object details are left untouched. */
export function withDuration(details, durationMs) {
  if (details === undefined || details === null) return { [TIMING_KEY]: { durationMs } };
  if (typeof details !== "object" || Array.isArray(details)) return details;
  return { ...details, [TIMING_KEY]: { durationMs } };
}

export function createTiming({ now = Date.now } = {}) {
  return defineExtension({
    name: "tarsbot.timing",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (_call, api, context) => {
          await api.memo(START_MEMO, now(), context);
          return undefined;
        },
        afterTool: async (_call, result, api, context) => {
          const start = await api.memo(START_MEMO, context);
          if (typeof start !== "number") return undefined;
          const durationMs = Math.max(0, now() - start);
          const details = withDuration(result.details, durationMs);
          if (details === result.details) return undefined;
          // Keep `output` by reference: the harness applies its output truncation only when it is unchanged.
          return { ...result, details };
        },
      }),
    ],
  });
}

export const Timing = createTiming();
