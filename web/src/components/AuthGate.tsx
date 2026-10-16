import { useEffect, useState } from "react";
import App from "../App";
import { auth, onUnauthorized } from "../lib/api";
import { LoginPage } from "./LoginPage";

type State = { kind: "loading" } | { kind: "anon" } | { kind: "authed"; email: string };

export function AuthGate() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    const off = onUnauthorized(() => setState({ kind: "anon" }));
    auth
      .me()
      .then((me) => alive && setState({ kind: "authed", email: me.email }))
      .catch(() => alive && setState((s) => (s.kind === "loading" ? { kind: "anon" } : s)));
    return () => {
      alive = false;
      off();
    };
  }, []);

  if (state.kind === "loading") {
    return (
      <div role="status" className="flex h-dvh items-center justify-center bg-surface text-sm text-fg-muted">
        加载中…
      </div>
    );
  }
  if (state.kind === "anon") return <LoginPage onLoggedIn={(email) => setState({ kind: "authed", email })} />;
  return <App email={state.email} onLoggedOut={() => setState({ kind: "anon" })} />;
}
