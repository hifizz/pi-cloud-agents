// AMP13-collaboration: opt-in browser notifications for a session's busy→idle transitions. These are local
// Notification API events fired while this page is open — not background push, and nothing is sent when the
// permission is denied or the toggle is off.
import { useCallback, useEffect, useRef, useState } from "react";

const KEY = "pca.notify";

export type NotifyPermission = "unsupported" | NotificationPermission;

export interface SessionNotifications {
  /** False when the Notification API does not exist in this browser. */
  supported: boolean;
  /** Live permission state; "denied" is surfaced in the UI instead of failing silently. */
  permission: NotifyPermission;
  /** User toggle (persisted). Only meaningful when permission === "granted". */
  enabled: boolean;
  /** Enable (requesting permission on first use) or disable. */
  onToggle: () => void;
}

function readPermission(): NotifyPermission {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

function loadEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function useSessionNotifications({ botId, botName, busy }: { botId?: string; botName?: string; busy: boolean }): SessionNotifications {
  const supported = typeof Notification !== "undefined";
  const [permission, setPermission] = useState<NotifyPermission>(readPermission);
  const [enabled, setEnabled] = useState<boolean>(loadEnabled);

  const onToggle = useCallback(() => {
    if (!supported) return;
    if (enabled) {
      setEnabled(false);
      try {
        globalThis.localStorage?.setItem(KEY, "0");
      } catch {
        /* storage unavailable */
      }
      return;
    }
    if (Notification.permission === "granted") {
      setEnabled(true);
      try {
        globalThis.localStorage?.setItem(KEY, "1");
      } catch {
        /* storage unavailable */
      }
      return;
    }
    if (Notification.permission === "denied") {
      setPermission("denied");
      return;
    }
    void Notification.requestPermission().then((p) => {
      setPermission(p);
      if (p === "granted") {
        setEnabled(true);
        try {
          globalThis.localStorage?.setItem(KEY, "1");
        } catch {
          /* storage unavailable */
        }
      }
    });
  }, [enabled, supported]);

  // A notification fires only on a real busy→idle transition of the SAME session: the first observed state is never
  // treated as a completion (loading an already-idle session stays silent) and switching sessions mid-run cannot
  // reuse the previous session's busy flag.
  const prev = useRef<{ id: string | undefined; busy: boolean }>({ id: botId, busy });
  useEffect(() => {
    const was = prev.current;
    prev.current = { id: botId, busy };
    if (!enabled || !supported || permission !== "granted" || !botId) return;
    if (was.busy && !busy && was.id === botId) {
      new Notification(botName ?? "pi-cloud-agents 会话", {
        body: "运行结束，等待你的下一步。",
        tag: `pca-session-${botId}`,
      });
    }
  }, [botId, botName, busy, enabled, permission, supported]);

  return { supported, permission, enabled, onToggle };
}
