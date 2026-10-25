// ask_user (bdots idea 14): a tool that parks a question with 2-4 clickable options for the human. Like approvals,
// it waits in an in-process center until the user clicks an option (or types any reply in chat, which also answers
// it); the choice comes back as the tool result. Non-blocking for the conversation: a typed message becomes a queued
// input, and the center resolves the waiting tool with it.
import { EventEmitter } from "node:events";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;

/** In-process registry of open questions. Emits "changed" on every list change. */
export class AskCenter extends EventEmitter {
  #open = new Map();

  /** @returns {Promise<string>} the chosen option text, or the typed reply text */
  ask({ id, conversationId, question, options, signal }) {
    const key = String(id);
    const existing = this.#open.get(key);
    if (existing) return existing.promise;
    if (signal?.aborted) return Promise.reject(abortError(signal));
    let settle;
    let fail;
    const promise = new Promise((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    const item = {
      id: key,
      conversationId: conversationId === undefined ? undefined : String(conversationId),
      question,
      options: [...options],
      askedAt: new Date().toISOString(),
    };
    const entry = { item, promise, settle, fail, cleanup: () => {} };
    if (signal) {
      const onAbort = () => {
        if (this.#open.get(key) !== entry) return;
        this.#open.delete(key);
        fail(abortError(signal));
        this.emit("changed");
      };
      signal.addEventListener("abort", onAbort, { once: true });
      entry.cleanup = () => signal.removeEventListener("abort", onAbort);
    }
    this.#open.set(key, entry);
    this.emit("changed");
    return promise;
  }

  list() {
    return [...this.#open.values()].map(({ item }) => ({ ...item }));
  }

  /** Resolve an open question with the chosen/typed text. @returns {boolean} false when no such question is open */
  answer(id, text) {
    const key = String(id);
    const entry = this.#open.get(key);
    if (!entry) return false;
    this.#open.delete(key);
    entry.cleanup();
    entry.settle(String(text));
    this.emit("changed");
    return true;
  }
}

function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const e = new Error("ask_user wait aborted");
  e.name = "AbortError";
  return e;
}

/** Process-wide center shared by the extension and the HTTP routes. */
export const asks = new AskCenter();

/**
 * @param {{ center?: AskCenter }} [opts]
 */
export function createAskUser(opts = {}) {
  const center = opts.center ?? asks;
  return defineExtension({
    name: "tarsbot.askUser",
    tools: [
      defineTool({
        name: "ask_user",
        description:
          "Ask the human a question with clickable options. Use instead of guessing when a decision is theirs " +
          "(which fix, whether to proceed). The user may also just type a reply in chat; any typed text answers the question too.",
        parameters: Type.Object({
          question: Type.String({ description: "The question to show" }),
          options: Type.Array(Type.String(), { minItems: MIN_OPTIONS, maxItems: MAX_OPTIONS, description: `${MIN_OPTIONS}-${MAX_OPTIONS} clickable answer options` }),
        }),
        replay: "safe",
        async execute(args, api, context) {
          const options = args.options.map((o) => String(o).slice(0, 200)).filter(Boolean);
          if (options.length < MIN_OPTIONS) throw new Error(`at least ${MIN_OPTIONS} non-empty options are required`);
          const answer = await center.ask({
            id: api.taskId,
            conversationId: api.conversationId,
            question: String(args.question).slice(0, 1000),
            options,
            signal: context?.abortSignal,
          });
          return { output: [{ type: "text", text: `User answered: ${answer}` }] };
        },
      }),
    ],
  });
}

export const AskUser = createAskUser();
