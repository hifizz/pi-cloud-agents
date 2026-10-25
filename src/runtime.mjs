// Production composition: which extensions and environment the Harness gets.
// Single integration point — later tasks add their extensions HERE (and only here).
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openHarness } from "./harness.mjs";
import { spaceEnv } from "./env.mjs";
import { ctx } from "./harness.mjs";
import { Preamble } from "./ext/preamble.mjs";
import { Search } from "./ext/search.mjs";
import { History } from "./ext/history.mjs";
import { Routines, createRoutineTools } from "./ext/routines.mjs";
import { Approval } from "./ext/approval.mjs";
import { Timing } from "./ext/timing.mjs";
import { LoopGuard } from "./ext/loop-guard.mjs";
import { OutputGuard } from "./ext/output-guard.mjs";
import { Memory } from "./ext/memory.mjs";
import { Skills } from "./ext/skills.mjs";
import { Jobs } from "./ext/jobs.mjs";
import { Quiet } from "./ext/quiet.mjs";
import { AskUser } from "./ext/ask-user.mjs";
import { FetchMarkdown } from "./ext/fetch-markdown.mjs";
import { createInterBot } from "./ext/interbot.mjs";

/**
 * Extensions installed in production, in order.
 * Order rules: LoopGuard and OutputGuard wrap every call, so they sit before Approval; Approval MUST stay last of the
 * hook extensions (its beforeTool must see the final arguments); Timing after Approval so approval wait is uncounted.
 * @param {{ harness?: any, bots?: any }} [io] harness + bot registry for the tools that reach other conversations
 */
export async function productionExtensions(io = {}) {
  const exts = [
    Preamble,
    Memory,
    Skills,
    Quiet,
    FetchMarkdown,
    CodingTools,
    Jobs,
    Search,
    History,
    LoopGuard,
    OutputGuard,
    AskUser,
  ];
  if (io.harness) {
    exts.push(createRoutineTools({ harness: io.harness }));
    if (io.bots) {
      exts.push(
        createInterBot({
          resolve: async (nameOrId) => {
            const bot = io.bots.get(nameOrId);
            return bot ? { conversationId: bot.conversationId, name: bot.name } : undefined;
          },
          submit: async (conversationId, prompt, requestId) => {
            const conv = await io.harness.conversation(conversationId, ctx);
            if (!conv) return { status: "conversation not found" };
            const sub = await conv.submit({ type: "input", content: prompt, whenBusy: "followUp", requestId }, ctx);
            const settled = await sub.wait(ctx);
            if (settled.status !== "done") return { status: settled.status };
            // The answer text: newest assistant entry at settle time.
            const page = await conv.entries({}, 5, undefined, ctx);
            for (const e of page.items) {
              for (const m of e.model ?? []) {
                if (m.role !== "assistant") continue;
                const text = (Array.isArray(m.content) ? m.content : [])
                  .filter((c) => c.type === "text")
                  .map((c) => c.text)
                  .join("\n");
                if (text.trim()) return { answer: text, status: "done" };
              }
            }
            return { answer: "", status: "done" };
          },
        }),
      );
    }
  }
  exts.push(Routines, Approval, Timing);
  return exts;
}

/** Production ExecutionEnv factory: read/write/edit/bash run inside the Sprite. */
export async function productionEnv() {
  return spaceEnv();
}

export async function bootstrap(overrides = {}) {
  // Tools that reach other conversations need the harness before it exists: open with the base set, then reopen the
  // registry with the full set once the harness is up (install publishes and wakes the scheduler at once).
  const { harness, registry, models } = await openHarness({ ...overrides, extensions: [], env: overrides.env ?? (await productionEnv()) });
  const exts = overrides.extensions ?? (await productionExtensions({ harness, bots: overrides.bots ?? undefined }));
  for (const ext of exts) registry.install(ext);
  return { harness, registry, models };
}
