import { useEffect, useState, type FormEvent } from "react";
import { ApiError, auth, googleLoginUrl } from "../lib/api";

const AUTH_ERRORS: Record<string, string> = {
  denied: "该邮箱不在允许名单",
  state: "登录失败，请重试",
  exchange: "登录失败，请重试",
};

const inputCls =
  "w-full rounded-md border border-line-strong bg-field px-3 py-2 text-sm text-fg focus-visible:outline-2 focus-visible:outline-accent";
const btnCls =
  "w-full rounded-md border border-line-strong px-3 py-2 text-center text-sm text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40";

export function LoginPage({ onLoggedIn }: { onLoggedIn: (email: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  // Surface ?auth_error=… from the Google callback once, then strip it from the URL.
  useEffect(() => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("auth_error");
    if (code === null) return;
    setError(AUTH_ERRORS[code] ?? "登录失败，请重试");
    url.searchParams.delete("auth_error");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const me = await auth.login(email.trim(), password);
      onLoggedIn(me.email);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? "尝试次数过多，请稍后再试" : err instanceof ApiError && err.status === 401 ? "邮箱或密码错误" : "登录失败，请重试");
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface p-4 text-fg">
      <div className="w-full max-w-sm space-y-5">
        <h1 className="text-center text-xl font-semibold">pi-cloud-agents</h1>
        {error && (
          <p role="alert" className="rounded-md bg-bad/10 px-3 py-2 text-sm text-bad">
            {error}
          </p>
        )}
        <a href={googleLoginUrl} className={btnCls}>
          使用 Google 登录
        </a>
        <form onSubmit={(e) => void submit(e)} className="space-y-3">
          <div className="space-y-1">
            <label htmlFor="login-email" className="text-xs text-fg-muted">
              邮箱
            </label>
            <input id="login-email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} />
          </div>
          <div className="space-y-1">
            <label htmlFor="login-password" className="text-xs text-fg-muted">
              密码
            </label>
            <input id="login-password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className={inputCls} />
          </div>
          <button type="submit" disabled={busy} className={btnCls}>
            {busy ? "登录中…" : "登录"}
          </button>
        </form>
      </div>
    </main>
  );
}
