// Only report what is new (bdots idea 12): for routine-driven background rounds, the model can call `mark_reported`
// with stable keys ("pr-123", "issue-7") it has just reported; a later round whose findings are all already-reported
// answers NO_UPDATE. The tool returns whether every key it was given was already marked, so the model can end its
// reply with a single quiet line instead of repeating the digest.
//
// Reported keys live in a conversation doc (rewindable) capped at 500 entries.
import { defineDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";

export const MAX_REPORTED = 500;

/** Conversation doc: reportedKeys: string[] (ordered, capped). */
export const ReportedDoc = defineDoc({
  kind: "tarsbot.reported",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  initial: () => ({ reportedKeys: [] }),
  checkpointWhen: () => true,
});

/**
 * Pure: which of `keys` are new vs already reported.
 * @returns {{fresh: string[], known: string[]}}
 */
export function partitionKeys(reportedKeys, keys) {
  const known = new Set(reportedKeys ?? []);
  const fresh = [];
  const knownHit = [];
  for (const k of keys) {
    const s = String(k).trim();
    if (!s) continue;
    if (known.has(s)) knownHit.push(s);
    else fresh.push(s);
  }
  return { fresh, known: knownHit };
}

export function createQuiet() {
  const markReported = defineTool({
    name: "mark_reported",
    description:
      "Record that you have just reported the given stable keys (ids like 'pr-123', 'issue-7', 'commit-abc'). " +
      "Returns which keys were NEW (just marked) and which were already reported. In a routine round where nothing " +
      "is new, reply with just NO_UPDATE instead of repeating the digest.",
    parameters: Type.Object({
      keys: Type.Array(Type.String(), { minItems: 1, maxItems: 50, description: "Stable keys of the items you reported" }),
    }),
    replay: "safe",
    async execute(args, api, context) {
      let result;
      await api.commit(async (tx) => {
        const doc = await tx.doc(ReportedDoc, api.conversationId);
        result = partitionKeys(doc.reportedKeys, args.keys);
        const seen = new Set(doc.reportedKeys);
        for (const k of result.fresh) seen.add(k);
        doc.reportedKeys = [...seen].slice(-MAX_REPORTED);
      }, context);
      return {
        output: [
          {
            type: "text",
            text:
              result.fresh.length > 0
                ? `marked ${result.fresh.length} new key(s): ${result.fresh.join(", ")}${result.known.length ? `; already reported: ${result.known.join(", ")}` : ""}`
                : `all ${result.known.length} key(s) were already reported`,
          },
        ],
      };
    },
  });

  return defineExtension({
    name: "tarsbot.quiet",
    tools: [markReported],
    sections: [
      section("quiet", async (input, context) => {
        const doc = await input.read.snapshot(ReportedDoc, input.conversationId, context);
        const keys = doc?.reportedKeys ?? [];
        if (keys.length === 0) return undefined;
        return `- You have already reported these keys in earlier rounds (do not repeat them; reply NO_UPDATE when nothing new): ${keys.slice(-30).join(", ")}`;
      }),
    ],
  });
}

export const Quiet = createQuiet();
