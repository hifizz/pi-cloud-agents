// Preview panel (AMP13-preview): open the dev server that is really running inside the current session's workspace
// Sprite. The workspace comes from the selected bot (mapBotsToWorkspaces, the same mapping the rest of the UI uses);
// the server resolves the binding — the panel never names a Sprite. The app is framed inside a sandboxed iframe so
// its scripts can run and interact but cannot read this origin's session cookie or DOM.
//
// The probe (GET .../preview?port=N) is a real check: "无服务" means the server could not reach anything on that port,
// never a cached guess. The port list is server-probed common dev ports plus whatever the user types.
import { useContext, useMemo, useRef, useState } from "react";
import { request } from "../../lib/api";
import { WorkspaceContext, describeError, mapBotsToWorkspaces } from "../../lib/workspaces";
import type { PanelContext, PanelDefinition } from "../types";

/** GET /api/workspaces/:id/preview?port=N — a real probe inside the workspace Sprite. */
interface ProbeResult {
  workspaceId: string;
  port?: number;
  ports: number[];
  up?: boolean;
  reason?: string;
}
/** POST /api/workspaces/:id/preview/token — mints a path capability bound to the current binding. */
interface CapResult {
  token: string;
  exp: number;
  /** The cap-bearing preview URL the server minted (cap-… already in the path). */
  url: string;
  ttlMs: number;
}
const probePreviewPort = (workspaceId: string, port: number) =>
  request<ProbeResult>("GET", `/api/workspaces/${encodeURIComponent(workspaceId)}/preview?port=${port}`);
const mintPreviewToken = (workspaceId: string, port: number) =>
  request<CapResult>("POST", `/api/workspaces/${encodeURIComponent(workspaceId)}/preview/token`, { port });

const inputCls =
  "w-24 rounded-md border border-line bg-raised px-2 py-1 text-sm text-fg outline-none focus:border-fg-muted";
const btnCls =
  "rounded-md border border-line bg-raised px-2.5 py-1 text-sm text-fg hover:bg-overlay disabled:opacity-50";

type State =
  | { kind: "idle" }
  | { kind: "probing" }
  | { kind: "empty" } // probed, nothing listening anywhere
  | { kind: "ready"; port: number; url: string } // probed up + capability minted; iframe loads the cap URL
  | { kind: "error"; message: string };

/** The iframe URL is the server-minted cap URL — the app's own assets/navigate stay authorized without the session
 * cookie (which the opaque sandbox deliberately does not send). The cap is binding-scoped and short-lived. */

function PreviewBody({ workspaceId }: { workspaceId: string }) {
  const [port, setPort] = useState("3000");
  const [state, setState] = useState<State>({ kind: "idle" });
  const [reloadSeq, setReloadSeq] = useState(0);
  const gen = useRef(0); // stale probes never overwrite a newer state

  const open = async (target?: number) => {
    const n = target ?? Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      setState({ kind: "error", message: "端口必须是 1–65535 的整数" });
      return;
    }
    const g = ++gen.current;
    setState({ kind: "probing" });
    try {
      const r = await probePreviewPort(workspaceId, n);
      if (g !== gen.current) return;
      if (r.up) {
        // Mint the path capability AFTER the probe: only a listening port gets a URL. The cap is what the
        // opaque-origin frame's subresources can actually carry — the session cookie is intentionally not sent.
        const cap = await mintPreviewToken(workspaceId, n);
        if (g !== gen.current) return;
        setState({ kind: "ready", port: n, url: cap.url });
      } else setState({ kind: "empty" });
    } catch (e) {
      if (g !== gen.current) return;
      setState({ kind: "error", message: describeError(e) });
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <label htmlFor="preview-port" className="text-xs text-fg-muted">
          端口
        </label>
        <input
          id="preview-port"
          className={inputCls}
          value={port}
          inputMode="numeric"
          onChange={(e) => setPort(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void open()}
        />
        <button type="button" className={btnCls} disabled={state.kind === "probing"} onClick={() => void open()}>
          {state.kind === "probing" ? "检查中…" : "打开预览"}
        </button>
        {state.kind === "ready" && (
          <>
            <button
              type="button"
              className={btnCls}
              onClick={() => {
                setReloadSeq((s) => s + 1);
                void open(state.port); // re-probe: a dead server becomes 无服务 instead of a stale frame
              }}
            >
              刷新
            </button>
            <a
              className="text-xs text-fg-muted underline underline-offset-2"
              href={state.url}
              target="_blank"
              rel="noreferrer"
            >
              新标签打开
            </a>
            <span className="ml-auto text-xs text-fg-muted">:{state.port}</span>
          </>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {state.kind === "idle" && (
          <p className="p-4 text-sm text-fg-muted">输入端口后「打开预览」：页面来自当前工作区 Sprite 内真实运行的服务。</p>
        )}
        {state.kind === "probing" && <p className="p-4 text-sm text-fg-muted">正在检查端口…</p>}
        {state.kind === "empty" && (
          <p className="p-4 text-sm text-fg-muted">
            无服务：该端口在当前工作区 Sprite 内没有进程监听。先在会话里让 Bot 启动开发服务器，再打开预览。
          </p>
        )}
        {state.kind === "error" && <p className="p-4 text-sm text-red-400">{state.message}</p>}
        {state.kind === "ready" && (
          <iframe
            key={`${state.port}:${reloadSeq}`}
            title={`预览 :${state.port}`}
            // allow-scripts: the app's JS runs and the page is interactive. NO allow-same-origin → opaque origin,
            // so the app can never read our session cookie, DOM or storage; no top-navigation, no popups, no forms
            // — matching the response-level `Content-Security-Policy: sandbox allow-scripts` the server applies, so
            // iframe and direct navigation are isolated identically. (The 新标签打开 link in OUR toolbar is outside
            // the frame and unaffected; the opened page is still CSP-sandboxed.)
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            className="h-full w-full border-0 bg-white"
            src={state.url}
          />
        )}
      </div>
    </div>
  );
}

function PreviewPanel({ bot, bots }: PanelContext) {
  const wsCtx = useContext(WorkspaceContext);
  // Resolve the bot's workspace the same way the rest of the UI does; the App's selected workspace is a hint only.
  const workspaceId = useMemo(() => {
    if (!bot) return wsCtx?.workspace?.id;
    const fromBot = bot.workspaceId;
    if (fromBot) return fromBot;
    if (!wsCtx?.workspace) return undefined;
    return mapBotsToWorkspaces(bots, [wsCtx.workspace]).get(bot.id) ?? wsCtx.workspace.id;
  }, [bot, bots, wsCtx]);

  if (!bot) return <p className="p-4 text-sm text-fg-muted">选择一个会话后，可预览其工作区 Sprite 内运行的服务。</p>;
  if (!workspaceId) return <p className="p-4 text-sm text-fg-muted">当前会话不属于任何工作区，无法预览。</p>;
  return <PreviewBody workspaceId={workspaceId} />;
}

export const previewPanel: PanelDefinition = {
  id: "preview",
  title: "预览",
  icon: "globe",
  Component: PreviewPanel,
};
