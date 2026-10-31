// Terminal routes: two endpoints on the same authenticated WebSocket guard (src/routes/auth.mjs:
// session cookie + Origin check on every upgrade; an anonymous or foreign-Origin socket never gets here).
//
//   WS /api/bots/:id/terminal      NON-interactive command console (src/terminal-env.mjs attachTerminal):
//                                  commands are staged through the Sprite runner, streamed, killable, and
//                                  refused by the shared danger classifier. No PTY, no shell state.
//   WS /api/bots/:id/terminal/pty  REAL interactive PTY (attachPtyTerminal): one tty shell per socket over
//                                  the provider's interactive factory (sprite.spawn {tty:true}). stdin /
//                                  resize / signal / close. This is a FULL-ACCESS trust boundary — no
//                                  per-command approval is possible on a raw byte stream; the UI gate keeps
//                                  that explicit, the server still enforces session -> ready workspace ->
//                                  active binding -> per-workspace factory, cwd derived server-side.
//
// ctx needs:
//   console:  app.ctx.bots + control + runtimeBash(workspaceId) -> bash(command)
//   pty:      app.ctx.bots + control + ptySession(workspaceId)  -> spawn({cwd, cols, rows, env}) -> shell
//             (wired like runtimeBash: binding lookup + provider.pty(binding.runtimeId); when absent the
//             endpoint reports "not available" instead of silently degrading to the console).
// Test seams: opts.runner (console runner client), opts.spawn (PTY spawn factory).
import { attachPtyTerminal, attachTerminal } from "../terminal-env.mjs";

export function register(app, opts = {}) {
  const { bots, control, runtimeBash, ptySession } = app.ctx;
  if (bots && control && typeof runtimeBash === "function") {
    app.ws("/api/bots/:id/terminal", (socket, { params }) => attachTerminal(app, socket, params.id, { runner: opts.runner }));
  } else {
    console.warn("routes/terminal: app.ctx.bots / control / runtimeBash is not set, the console route is not registered");
  }
  if (bots && control && (typeof ptySession === "function" || typeof opts.spawn === "function")) {
    app.ws("/api/bots/:id/terminal/pty", (socket, { params }) => attachPtyTerminal(app, socket, params.id, { spawn: opts.spawn }));
  } else {
    console.warn("routes/terminal: app.ctx.ptySession is not set, the interactive terminal route is not registered");
  }
}
