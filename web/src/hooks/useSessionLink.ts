// AMP13-collaboration: session deep links (?bot=<id>). Under the existing whitelist model every signed-in member may
// open any session — the link only encodes which one, there are no public or anonymous URLs.
import { useCallback, useEffect, useState } from "react";

const PARAM = "bot";

/** The ?bot=<id> target of the current URL, or undefined when absent/empty. */
export function readSessionLink(loc: Pick<Location, "search"> = globalThis.location): string | undefined {
  const id = new URLSearchParams(loc.search).get(PARAM);
  return id && id.trim() ? id : undefined;
}

/** Absolute share URL for a session; other query params are preserved. */
export function sessionUrl(botId: string, loc: Pick<Location, "href"> = globalThis.location): string {
  const url = new URL(loc.href);
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
  /** Push a history entry pointing at this session (undefined clears the param). */
  setLink: (botId: string | undefined) => void;
}

export function useSessionLink(): SessionLink {
  const [linkBot, setLinkBot] = useState<string | undefined>(() => readSessionLink());
  useEffect(() => {
    const onPop = () => setLinkBot(readSessionLink());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const setLink = useCallback((botId: string | undefined) => {
    const url = new URL(window.location.href);
    url.searchParams.delete("loopRun");
    if (botId) url.searchParams.set(PARAM, botId);
    else url.searchParams.delete(PARAM);
    window.history.pushState(null, "", url.pathname + url.search + url.hash);
    setLinkBot(botId);
  }, []);
  return { linkBot, setLink };
}
