// ask_user routes (idea 14), mirroring approvals:
//   GET  /api/asks            → open questions [{id, conversationId, question, options, askedAt}]
//   POST /api/asks/:id        {answer: string} → {ok: true}; 404 when not open
//   WS   /api/asks/stream     → {type:"asks", items} on connect and after every change
// Guarded by routes/auth.mjs like every other /api route.
import { HttpError } from "../api.mjs";
import { asks } from "../ext/ask-user.mjs";

const toJson = (value) => JSON.stringify(value);

export function register(app) {
  app.get("/api/asks", () => asks.list());

  app.post("/api/asks/:id", (_req, _res, { params, body }) => {
    if (body === null || typeof body !== "object" || Array.isArray(body) || typeof body.answer !== "string" || !body.answer.trim()) {
      throw new HttpError(400, "body must be {answer: non-empty string}");
    }
    if (!asks.answer(params.id, body.answer)) throw new HttpError(404, `no open question: ${params.id}`);
    return { ok: true };
  });

  app.ws("/api/asks/stream", (socket) => {
    const push = () => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(toJson({ type: "asks", items: asks.list() }));
    };
    const off = () => asks.off("changed", push);
    socket.on("close", off);
    socket.on("error", off);
    asks.on("changed", push);
    push();
  });
}
