// Bot-to-bot messaging (bdots idea 9): a `message_bot` tool that submits a prompt to ANOTHER bot's conversation and
// waits for its answer. Idempotent per (calling task, tool call) via requestId, capped at MAX_HOPS relay hops so two
// bots cannot ping-pong forever. Bots share one sandbox, so files transfer by path, not content.
//
// The tool needs the harness to reach other conversations; production wires it in runtime.mjs (createInterBot is a
// factory; tests construct their own io).
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";

export const MAX_HOPS = 6;
const HOP_KEY = "tarsbot.hops";

/**
 * Build the interbot extension.
 * @param {{ resolve: (nameOrId: string) => Promise<{conversationId: number|string, name: string} | undefined>,
 *           submit: (conversationId: number|string, prompt: string, requestId: string) => Promise<{answer?: string, status?: string}> }} io
 *   Production supplies resolve via BotRegistry and submit via the conversation handle (runtime.mjs).
 */
export function createInterBot(io) {
  if (!io?.resolve || !io?.submit) throw new Error("createInterBot requires {resolve, submit}");

  const messageBot = defineTool({
    name: "message_bot",
    description:
      "Send a message to another bot and wait for its reply. The recipient sees the message as user input prefixed " +
      "with your name and answers in its own conversation. You both share the same Linux machine, so pass file paths, " +
      "not file contents. Hop budget: replies that need another message_bot must not exceed 6 hops total.",
    parameters: Type.Object({
      bot: Type.String({ description: "Name or id of the recipient bot" }),
      message: Type.String({ description: "What to ask or tell the other bot" }),
    }),
    replay: "safe",
    async execute(args, api, context) {
      const target = await io.resolve(args.bot);
      if (!target) return { output: [{ type: "text", text: `no such bot: ${args.bot}` }], isError: true };

      // Relay budget: the recipient's prompt carries "from <bot> hop N/6"; N+1 > MAX_HOPS is refused.
      const hopMatch = /hop (\d+)\/\d+/.exec(String(args.message));
      const hops = hopMatch ? Number(hopMatch[1]) : 0;
      if (hops + 1 > MAX_HOPS) {
        return {
          output: [
            { type: "text", text: `message relay limit reached (${MAX_HOPS} hops); answer the sender directly instead of forwarding` },
          ],
          isError: true,
        };
      }

      // Idempotency: one requestId per (task, call), so a rerun after a crash resumes the same submission.
      const requestId = `interbot:${api.taskId}:${api.callId}`;
      const prompt = `[from bot ${api.conversationId} | hop ${hops + 1}/${MAX_HOPS}]\n${String(args.message)}`;
      const r = await io.submit(target.conversationId, prompt, requestId);
      if (r.status && r.status !== "done") {
        return { output: [{ type: "text", text: `${target.name} did not answer (${r.status})` }], isError: true };
      }
      return { output: [{ type: "text", text: `${target.name} replied:\n\n${r.answer ?? "(no text answer)"}` }] };
    },
  });

  return defineExtension({ name: "tarsbot.interbot", tools: [messageBot] });
}
