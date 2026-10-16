// Approval routes (spec F10):
//   GET  /api/approvals            → pending approvals [{taskId, conversationId, toolName, args, reason, requestedAt}]
//   POST /api/approvals/:taskId    {approved: boolean} → {ok: true}; 404 when not pending
//   WS   /api/approvals/stream     → {type:"approvals", items} on connect and after every change
// SECURITY: this plugin does no authentication itself; the global guard from routes/auth.mjs (app.guard) protects it.
import { HttpError } from "../api.mjs";
import { approvals } from "../ext/approval.mjs";

const toJson = (value) => JSON.stringify(value);

/** @param {import("../ext/approval.mjs").ApprovalCenter} center */
export function createRoutes(center) {
  return function register(app) {
    app.get("/api/approvals", () => center.list());

    app.post("/api/approvals/:taskId", (_req, _res, { params, body }) => {
      if (body === null || typeof body !== "object" || Array.isArray(body) || typeof body.approved !== "boolean") {
        throw new HttpError(400, "body must be {approved: boolean}");
      }
      if (!center.resolve(params.taskId, body.approved)) throw new HttpError(404, `no pending approval: ${params.taskId}`);
      return { ok: true };
    });

    app.ws("/api/approvals/stream", (socket) => {
      const push = () => {
        if (socket.readyState !== socket.OPEN) return;
        socket.send(toJson({ type: "approvals", items: center.list() }));
      };
      const off = () => center.off("changed", push);
      socket.on("close", off);
      socket.on("error", off);
      center.on("changed", push);
      push();
    });
  };
}

export const register = createRoutes(approvals);
