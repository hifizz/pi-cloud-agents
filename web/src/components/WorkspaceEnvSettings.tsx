// Workspace-level env-var settings module for the workspace home (workspace-IA demo). Manages the workspace
// DEFAULTS directly (the session Environment pane stays the place for per-session overrides). Every terminal
// state is explicit: loading, error + retry, disabled (no TARSBOT_ENV_KEY), or the list + add/remove form.
import { useCallback, useEffect, useState } from "react";
import { describeError, formatTime, workspacesApi, type EnvVarEntry } from "../lib/workspaces";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; enabled: boolean; vars: EnvVarEntry[] };

export function WorkspaceEnvSettings({ workspaceId }: { workspaceId: string }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState<string>(); // "save" | var name being removed
  const [formErr, setFormErr] = useState<string>();

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const res = await workspacesApi.envList(workspaceId);
      setState({ status: "ok", enabled: res.enabled, vars: Array.isArray(res.vars) ? res.vars : [] });
    } catch (e) {
      setState({ status: "error", message: describeError(e) });
    }
  }, [workspaceId]);
  useEffect(() => {
    setName("");
    setValue("");
    setFormErr(undefined);
    void load();
  }, [load]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n || busy) return;
    setBusy("save");
    setFormErr(undefined);
    try {
      await workspacesApi.envSet(workspaceId, n, value);
      setName("");
      setValue("");
      await load();
    } catch (err) {
      setFormErr(describeError(err));
    } finally {
      setBusy(undefined);
    }
  };

  const remove = async (n: string) => {
    if (busy) return;
    setBusy(n);
    setFormErr(undefined);
    try {
      await workspacesApi.envRemove(workspaceId, n);
      await load();
    } catch (err) {
      setFormErr(describeError(err));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Card size="sm" className="text-xs" data-testid="workspace-env-settings">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-[13px]">环境变量</CardTitle>
        {state.status === "ok" && <span className="text-[11px] text-muted-foreground">{state.vars.length} 个工作区默认</span>}
      </CardHeader>
      <CardContent>
        {state.status === "loading" && <p className="text-muted-foreground">加载中…</p>}

        {state.status === "error" && (
          <div className="flex items-center gap-2 text-destructive">
            <span className="min-w-0 flex-1">加载失败：{state.message}</span>
            <button type="button" onClick={() => void load()} className="shrink-0 underline focus-visible:outline-2 focus-visible:outline-ring">
              重试
            </button>
          </div>
        )}

        {state.status === "ok" && !state.enabled && (
          <p className="text-muted-foreground">
            未启用：服务器未配置 <code className="font-mono">TARSBOT_ENV_KEY</code>，无法加密保存变量值。配置后可在此管理工作区默认环境变量。
          </p>
        )}

        {state.status === "ok" && state.enabled && (
          <>
            {state.vars.length === 0 ? (
              <p className="text-muted-foreground">还没有工作区默认变量。新命令、控制台和 PTY 会注入这些值。</p>
            ) : (
              <ul className="space-y-1">
                {state.vars.map((v) => (
                  <li key={v.name} className="flex items-center gap-2" data-testid={`env-var-${v.name}`}>
                    <span className="min-w-0 flex-1 truncate font-mono text-foreground">{v.name}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">{v.updatedAt ? formatTime(v.updatedAt) : ""}</span>
                    <Badge variant="secondary" className="text-[10px]">已加密</Badge>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => void remove(v.name)}
                      disabled={busy !== undefined}
                    >
                      {busy === v.name ? "删除中…" : "删除"}
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <form className="mt-2 flex items-start gap-2" onSubmit={(e) => void save(e)} aria-label="新增环境变量">
              <div className="w-1/3">
                <Input
                  className="h-7 text-xs"
                  placeholder="变量名，如 DEMO_COLOR"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  aria-label="变量名"
                  disabled={busy !== undefined}
                />
              </div>
              <div className="flex-1">
                <Input
                  className="h-7 text-xs"
                  placeholder="值（只写不读，加密保存；空字符串有效）"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  aria-label="变量值"
                  disabled={busy !== undefined}
                />
              </div>
              <Button type="submit" size="sm" disabled={busy !== undefined || !name.trim()} className="shrink-0">
                {busy === "save" ? "保存中…" : "保存"}
              </Button>
            </form>
            {formErr && (
              <p role="alert" className="mt-1 text-destructive">
                {formErr}
              </p>
            )}
            <p className="mt-1 text-[11px] text-muted-foreground">值只写不读；Session 可在其右侧 Environment 面板覆盖或禁用单个变量。</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
