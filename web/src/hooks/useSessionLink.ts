// AMP13-collaboration: session deep links (?bot=<id>). Under the existing whitelist model every signed-in member may
// open any session — the link only encodes which one, there are no public or anonymous URLs.
import { useCallback, useEffect, useState } from "react";

const PARAM = "bot";

/** The ?bot=<id> target of the current URL, or undefined when absent/empty. */
export function readSessionLink(loc: Pick<Location, "search"> = globalThis.location): string | undefined {
  const id = new URLSearchParams(loc.search).get(PARAM);
  return id && id.trim() ? id : undefined;
}

export function readWorkspaceLink(loc: Pick<Location, "search"> = globalThis.location): string | undefined {
  const id = new URLSearchParams(loc.search).get("workspace");
  return id && id.trim() ? id : undefined;
}

/** The ?loops=… view of the current URL: `list`, `new` (create form), or a loop id — `edit=1` marks the editor. */
export interface LoopsLink {
  mode: "list" | "new" | "runs" | "edit";
  loopId?: string;
}

export function readLoopsLink(loc: Pick<Location, "search"> = globalThis.location): LoopsLink | undefined {
  const q = new URLSearchParams(loc.search);
  const raw = q.get("loops");
  if (!raw || !raw.trim()) return undefined;
  if (raw === "list") return { mode: "list" };
  if (raw === "new") return { mode: "new" };
  return q.get("edit") === "1" ? { mode: "edit", loopId: raw } : { mode: "runs", loopId: raw };
}

/** Absolute share URL for a session; unrelated query params are preserved. */
export function sessionUrl(botId: string, loc: Pick<Location, "href"> = globalThis.location): string {
  const url = new URL(loc.href);
  url.searchParams.delete("workspace");
  url.searchParams.delete("loops");
  url.searchParams.delete("edit");
  url.searchParams.set(PARAM, botId);
  return url.toString();
}

/** Copy the session deep link. Falls back to a hidden textarea + execCommand when the Clipboard API is missing
 * (e.g. insecure contexts); rejects so the caller can surface a copy failure. */
export async function copySessionLink(botId: string): Promise<void> {
  const text = sessionUrl(botId);
  const clip = globalThis.navigator?.clipboard;
  if (clip?.writeText) {
    await clip.writeText(text);
    return;
  }
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  el.style.position = "fixed";
  el.style.opacity = "0";
  document.body.appendChild(el);
  el.select();
  try {
    if (!document.execCommand("copy")) throw new Error("复制失败：浏览器拒绝了剪贴板操作");
  } finally {
    el.remove();
  }
}

export interface SessionLink {
  /** The ?bot=<id> currently in the address bar (tracks user picks and browser back/forward). */
  linkBot: string | undefined;
  /** Push a history entry pointing at this session (undefined clears the param). `loops` keeps the workspace's
   * Loops surface addressable (?workspace=…&loops=list|new|<loopId>, edit=1 for the editor). */
  setLink: (botId: string | undefined, workspaceId?: string, loops?: LoopsLink) => void;
}

export function useSessionLink(): SessionLink {
  const [linkBot, setLinkBot] = useState<string | undefined>(() => readSessionLink());
  useEffect(() => {
    const onPop = () => setLinkBot(readSessionLink());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const setLink = useCallback((botId: string | undefined, workspaceId?: string, loops?: LoopsLink) => {
    const url = new URL(window.location.href);
    url.searchParams.delete("loopRun");
    if (loops) {
      url.searchParams.set("loops", loops.mode === "list" ? "list" : loops.mode === "new" ? "new" : (loops.loopId ?? "list"));
      if (loops.mode === "edit") url.searchParams.set("edit", "1");
      else url.searchParams.delete("edit");
    } else {
      url.searchParams.delete("loops");
      url.searchParams.delete("edit");
    }
    if (!botId && workspaceId) url.searchParams.set("workspace", workspaceId);
    else url.searchParams.delete("workspace");
    if (botId) url.searchParams.set(PARAM, botId);
    else url.searchParams.delete(PARAM);
    window.history.pushState(null, "", url.pathname + url.search + url.hash);
    setLinkBot(botId);
  }, []);
  return { linkBot, setLink };
}
