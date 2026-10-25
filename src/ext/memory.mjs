// Memory layer (bdots memory.ts, idea 6): a durable, per-bot list of long-lived facts the bot itself maintains.
//
// Two scopes:
//  - conversation doc `tarsbot.memory` (history: "rewindable"): the memory list itself, one bullet per fact,
//    deduplicated, capped at 8000 characters (bdots' limits).
//  - session doc `tarsbot.memoryRevisions`: the last 50 full snapshots of every bot's memory, so a bad `remember`
//    can be undone (`restore_revision`).
//
// The list is injected into the system prompt as a `<memory>` section (after the preamble), and the tools
// `remember` / `list_memories` / `forget` / `restore_revision` let the model manage it. Injection reads the doc
// through the prompt's own `read` (committed document reads), so it never races a write.
import { defineDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";

export const MAX_CHARS = 8000;
export const KEEP_REVISIONS = 50;

/** One bot's memory list. Rewindable so a fork keeps the memory at the fork point. */
export const MemoryDoc = defineDoc({
  kind: "tarsbot.memory",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  initial: () => ({ bullets: [] }),
  checkpointWhen: () => true, // full snapshot per change: revisions restore exact states
});

/** Session-wide revision log: conversations -> [{rev, at, bullets}] capped at KEEP_REVISIONS per bot. */
export const MemoryRevisionsDoc = defineDoc({
  kind: "tarsbot.memoryRevisions",
  version: 1,
  scope: "session",
  initial: () => ({ conversations: {} }),
  checkpointWhen: () => false,
});

const normalize = (b) => String(b ?? "").trim().replace(/\s+/g, " ");

/** Render the memory bullets for the prompt; null when there is nothing to show. */
export function renderMemory(bullets) {
  const list = (bullets ?? []).map(normalize).filter(Boolean);
  if (list.length === 0) return undefined;
  return `- Things you remember about the user, their projects and your own setup (kept across conversations):\n${list
    .map((b) => `  - ${b}`)
    .join("\n")}`;
}

/** Create-or-get a nested array on a tracked doc: `??=` alone stores a detached clone; re-read after assignment. */
function arrayAt(obj, key) {
  if (!Array.isArray(obj[key])) obj[key] = [];
  return obj[key];
}

/** Add bullets with dedup + char cap; returns {bullets, added, skipped}. Pure. */
export function addBullets(bullets, additions) {
  const list = [...(bullets ?? [])];
  const skipped = [];
  let added = 0;
  for (const raw of additions) {
    const b = normalize(raw);
    if (!b) continue;
    if (list.some((x) => normalize(x) === b)) {
      skipped.push(b);
      continue;
    }
    const projected = [...list, b].join("\n").length;
    if (projected > MAX_CHARS) {
      skipped.push(b);
      continue;
    }
    list.push(b);
    added++;
  }
  return { bullets: list, added, skipped };
}

/** Remove bullets matching a substring (case-insensitive); returns {bullets, removed}. Pure. */
export function removeBullets(bullets, needle) {
  const n = String(needle ?? "").toLowerCase();
  const keep = [];
  const removed = [];
  for (const b of bullets ?? []) {
    if (n && b.toLowerCase().includes(n)) removed.push(b);
    else keep.push(b);
  }
  return { bullets: keep, removed };
}

/**
 * Build the memory extension. Tools write the conversation doc and append a revision entry in one commit.
 * @param {{ now?: () => number }} [opts]
 */
export function createMemory(opts = {}) {
  const now = opts.now ?? Date.now;

  const remember = defineTool({
    name: "remember",
    description:
      `Save durable facts about the user, their projects or your setup for future conversations (max ${MAX_CHARS} chars total). ` +
      "Each fact is one short bullet. Duplicates are ignored. Use for preferences, decisions and context that outlive a task — not for task state.",
    parameters: Type.Object({
      facts: Type.Array(Type.String({ description: "One fact per entry, as a short bullet" }), { minItems: 1, maxItems: 20 }),
    }),
    replay: "safe",
    async execute(args, api, context) {
      let result;
      await api.commit(async (tx) => {
        const doc = await tx.doc(MemoryDoc, api.conversationId);
        result = addBullets(doc.bullets, args.facts);
        doc.bullets = result.bullets;
        const revs = await tx.doc(MemoryRevisionsDoc);
        const per = arrayAt(revs.conversations, String(api.conversationId));
        per.push({ rev: per.length + 1, at: now(), bullets: [...doc.bullets] });
        while (per.length > KEEP_REVISIONS) per.shift();
      }, context);
      const lines = [`remembered ${result.added} fact(s); memory now ${result.bullets.join("\n").length}/${MAX_CHARS} chars`];
      if (result.skipped.length) lines.push(`skipped ${result.skipped.length} (duplicate or over the cap): ${result.skipped.join(" / ").slice(0, 200)}`);
      return { output: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  const listMemories = defineTool({
    name: "list_memories",
    description: "List your current durable memory bullets.",
    parameters: Type.Object({}),
    replay: "safe",
    async execute(_args, _api, _context) {
      return { output: [{ type: "text", text: "see the <memory> section in your system prompt" }] };
    },
  });

  const forget = defineTool({
    name: "forget",
    description: "Remove memory bullets that contain the given substring (case-insensitive).",
    parameters: Type.Object({ contains: Type.String({ description: "Substring every removed bullet must contain" }) }),
    replay: "safe",
    async execute(args, api, context) {
      let removed = [];
      await api.commit(async (tx) => {
        const doc = await tx.doc(MemoryDoc, api.conversationId);
        const r = removeBullets(doc.bullets, args.contains);
        removed = r.removed;
        doc.bullets = r.bullets;
        const revs = await tx.doc(MemoryRevisionsDoc);
        const per = arrayAt(revs.conversations, String(api.conversationId));
        per.push({ rev: per.length + 1, at: now(), bullets: [...doc.bullets] });
        while (per.length > KEEP_REVISIONS) per.shift();
      }, context);
      return {
        output: [
          { type: "text", text: removed.length ? `removed ${removed.length} bullet(s): ${removed.join(" / ")}` : "no matching bullets" },
        ],
      };
    },
  });

  const restoreRevision = defineTool({
    name: "restore_revision",
    description: `Restore your memory to an earlier revision (see list_memories output in history). Keeps the last ${KEEP_REVISIONS} revisions.`,
    parameters: Type.Object({
      rev: Type.Integer({ description: "Revision number to restore" }),
    }),
    replay: "safe",
    async execute(args, api, context) {
      let restored = null;
      await api.commit(async (tx) => {
        const revs = await tx.doc(MemoryRevisionsDoc);
        const per = revs.conversations[String(api.conversationId)] ?? [];
        const snap = per.find((r) => r.rev === args.rev);
        if (snap) {
          const doc = await tx.doc(MemoryDoc, api.conversationId);
          doc.bullets = [...snap.bullets];
          per.push({ rev: per.length + 1, at: now(), bullets: [...doc.bullets] });
          while (per.length > KEEP_REVISIONS) per.shift();
          restored = snap;
        }
      }, context);
      if (!restored) return { output: [{ type: "text", text: `revision ${args.rev} not found` }], isError: true };
      return { output: [{ type: "text", text: `restored revision ${args.rev} (${restored.bullets.length} bullets)` }] };
    },
  });

  return defineExtension({
    name: "tarsbot.memory",
    tools: [remember, listMemories, forget, restoreRevision],
    sections: [
      section("memory", async (input, context) => {
        const doc = await input.read.snapshot(MemoryDoc, input.conversationId, context);
        return renderMemory(doc?.bullets);
      }),
    ],
  });
}

export const Memory = createMemory();
