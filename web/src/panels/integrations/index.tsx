// Integrations panel (AMP13-integrations, revised): install / enable / disable / uninstall Skills and
// MCP endpoints FOR THE PI AGENT, scoped to the selected workspace. This is an INSTALL UI — not a
// human-call/paste panel. Installed skills appear in the agent's system context and load via the
// load_skill tool; installed MCP servers expose real tools (mcp__*) to the model, each call gated by
// the existing approval flow.
import { useCallback, useContext, useEffect, useState } from "react";
import { request } from "../../lib/api";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { WorkspaceContext, describeError } from "../../lib/workspaces";
import type { PanelContext, PanelDefinition } from "../types";

// ---- wire shapes (src/routes/integrations.mjs) ------------------------------------------------------------------

export interface IntegrationInstall {
  id: string;
  kind: "skill" | "mcp";
  workspaceId: string;
  name: string;
  description?: string;
  enabled: boolean;
  source?: { type: string; url?: string; path?: string; protocolVersion?: string; transport?: string };
  tools?: { name: string; description?: string }[];
  toolCount?: number;
  hasCredential?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

interface IntegrationsInfo {
  kinds: string[];
  mcp: { protocolVersion: string; transport: string; oauth: boolean; note?: string };
  skills: { scanDirs: string[]; file: string };
  slack: { implemented: boolean; reason?: string };
}

interface SkillFile {
  path: string;
  name: string;
}

const enc = encodeURIComponent;

export const integrationsApi = {
  info: () => request<IntegrationsInfo>("GET", "/api/integrations"),
  list: (wsId: string) => request<{ installs: IntegrationInstall[] }>("GET", `/api/workspaces/${enc(wsId)}/integrations`),
  installSkill: (wsId: string, input: { name?: string; description?: string; content: string }) =>
    request<{ install: IntegrationInstall }>("POST", `/api/workspaces/${enc(wsId)}/integrations`, { kind: "skill", ...input }),
  installSkillFile: (wsId: string, input: { bot: string; path: string; name?: string; description?: string }) =>
    request<{ install: IntegrationInstall }>("POST", `/api/workspaces/${enc(wsId)}/integrations`, { kind: "skill-file", ...input }),
  installMcp: (wsId: string, input: { name: string; url: string; tokenEnv?: string }) =>
    request<{ install: IntegrationInstall }>("POST", `/api/workspaces/${enc(wsId)}/integrations`, { kind: "mcp", ...input }),
  setEnabled: (wsId: string, id: string, enabled: boolean) =>
    request<{ install: IntegrationInstall; applied: { configured: number; failed: string[] } }>(
      "POST",
      `/api/workspaces/${enc(wsId)}/integrations/${enc(id)}/enable`,
      { enabled },
    ),
  uninstall: (wsId: string, id: string) =>
    request<{ removed: { id: string } }>("POST", `/api/workspaces/${enc(wsId)}/integrations/${enc(id)}/uninstall`, {}),
  workspaceSkills: (wsId: string, botId: string) =>
    request<{ skills: SkillFile[] }>("GET", `/api/workspaces/${enc(wsId)}/integrations/skills?bot=${enc(botId)}`),
  skillContent: (wsId: string, id: string) => request<{ install: IntegrationInstall; content: string }>("GET", `/api/workspaces/${enc(wsId)}/integrations/${enc(id)}`),
};

function StatusLine({ error, notice }: { error?: string; notice?: string }) {
  return (
    <>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-muted-foreground">
          {notice}
        </p>
      )}
    </>
  );
}

// ---- install list --------------------------------------------------------------------------------------------------

function InstallRow({ install, onToggle, onRemove, onPreview, busy }: {
  install: IntegrationInstall;
  onToggle: (i: IntegrationInstall) => void;
  onRemove: (i: IntegrationInstall) => void;
  onPreview: (i: IntegrationInstall) => void;
  busy: boolean;
}) {
  return (
    <li className="rounded-md border border-border bg-muted/50 p-2" data-testid={`install-${install.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">
            {install.name}
            <Badge variant="secondary" className="ml-2 rounded-sm px-1 py-0.5 text-[10px] uppercase tracking-wide">{install.kind}</Badge>
            {!install.enabled && <Badge variant="destructive" className="ml-1 rounded-sm px-1 py-0.5 text-[10px] uppercase tracking-wide">停用</Badge>}
          </p>
          {install.description && <p className="mt-0.5 truncate text-muted-foreground">{install.description}</p>}
          <p className="mt-0.5 text-muted-foreground">
            {install.kind === "mcp" ? (
              <>
                {install.source?.url} · {install.toolCount ?? 0} 工具
                {install.hasCredential ? " · 已配置凭据(env)" : " · 无凭据"}
              </>
            ) : (
              <>skill{install.source?.path ? ` · 来自 ${install.source.path}` : " · 上传"}</>
            )}
          </p>
          {install.kind === "mcp" && install.tools && install.tools.length > 0 && (
            <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" title={install.tools.map((t) => t.name).join(", ")}>
              {install.tools.map((t) => t.name).join(", ")}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <div className="flex gap-1">
            {install.kind === "skill" && (
              <Button type="button" variant="outline" size="xs" disabled={busy} onClick={() => onPreview(install)} aria-label={`预览 ${install.name}`}>
                预览
              </Button>
            )}
            <Button type="button" variant="outline" size="xs" disabled={busy} onClick={() => onToggle(install)} aria-label={install.enabled ? `停用 ${install.name}` : `启用 ${install.name}`}>
              {install.enabled ? "停用" : "启用"}
            </Button>
            <Button type="button" variant="outline" size="xs" disabled={busy} onClick={() => onRemove(install)} aria-label={`卸载 ${install.name}`}>
              卸载
            </Button>
          </div>
        </div>
      </div>
    </li>
  );
}

// ---- install forms --------------------------------------------------------------------------------------------------

function InstallSkillForm({ wsId, onDone, onCancel }: { wsId: string; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !content.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      await integrationsApi.installSkill(wsId, { name: name.trim() || undefined, description: desc.trim() || undefined, content });
      onDone();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} aria-label="安装 Skill" className="space-y-2 rounded-md border border-border bg-muted/50 p-2">
      <p className="text-muted-foreground">粘贴 SKILL.md 内容（含 name/description frontmatter）。保存为快照，安装后 Pi 通过 load_skill 调用。</p>
      <Input aria-label="Skill 名称（可选，frontmatter 优先）" placeholder="名称（可选，frontmatter 优先）" value={name} onChange={(e) => setName(e.target.value)} />
      <Input aria-label="描述（可选）" placeholder="描述（可选）" value={desc} onChange={(e) => setDesc(e.target.value)} />
      <Textarea aria-label="SKILL.md 内容" placeholder="---\nname: ...\ndescription: ...\n---\n内容" rows={6} value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} required />
      <StatusLine error={error} />
      <div className="flex gap-2">
        <Button type="submit" variant="outline" size="sm" disabled={busy || !content.trim()}>
          {busy ? "安装中…" : "安装 Skill"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          取消
        </Button>
      </div>
    </form>
  );
}

function InstallSkillFileForm({ wsId, bot, onDone, onCancel }: { wsId: string; bot?: PanelContext["bot"]; onDone: () => void; onCancel: () => void }) {
  const [skills, setSkills] = useState<SkillFile[]>();
  const [picked, setPicked] = useState("");
  const [preview, setPreview] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!bot) return;
    integrationsApi
      .workspaceSkills(wsId, bot.id)
      .then((r) => setSkills(r.skills))
      .catch((e) => setError(describeError(e)));
  }, [wsId, bot]);

  const read = async (path: string) => {
    setPicked(path);
    setError(undefined);
    try {
      const r = await request<{ skill: { path: string; content: string } }>("POST", `/api/workspaces/${enc(wsId)}/integrations/skills/read`, { bot: bot?.id, path });
      setPreview(r.skill.content);
    } catch (e) {
      setError(describeError(e));
      setPreview(undefined);
    }
  };

  const install = async () => {
    if (!picked || !bot) return;
    setBusy(true);
    setError(undefined);
    try {
      await integrationsApi.installSkillFile(wsId, { bot: bot.id, path: picked });
      onDone();
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  };

  return (
    <div aria-label="从工作区文件安装" className="space-y-2 rounded-md border border-border bg-muted/50 p-2">
      <p className="text-muted-foreground">会话目录中的 SKILL.md（真实文件，安装为快照，不执行内容）。</p>
      {!bot && <p className="text-muted-foreground">选择一个会话后才能扫描工作区文件。</p>}
      {skills && skills.length === 0 && <p className="text-muted-foreground">会话目录内没有 SKILL.md。</p>}
      <ul className="space-y-1">
        {(skills ?? []).map((s) => (
          <li key={s.path} className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" className={`min-w-0 flex-1 justify-start truncate font-mono ${picked === s.path ? "border-ring" : ""}`} onClick={() => void read(s.path)} title={s.path}>
              {s.path}
            </Button>
          </li>
        ))}
      </ul>
      {preview && <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted p-2 text-foreground">{preview}</pre>}
      <StatusLine error={error} />
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" disabled={busy || !picked} onClick={() => void install()}>
          {busy ? "安装中…" : "安装选中文件"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  );
}

function InstallMcpForm({ wsId, onDone, onCancel }: { wsId: string; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [tokenEnv, setTokenEnv] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !name.trim() || !url.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      await integrationsApi.installMcp(wsId, { name: name.trim(), url: url.trim(), tokenEnv: tokenEnv.trim() || undefined });
      onDone();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} aria-label="添加 MCP 服务端" className="space-y-2 rounded-md border border-border bg-muted/50 p-2">
      <p className="text-muted-foreground">
        命名 HTTP endpoint（公网 http(s)，Streamable HTTP / 协议 2025-03-26）。安装时真实 initialize + tools/list 校验。
        凭据只填环境变量名（Bearer token），明文密钥不接收、不保存。OAuth 未支持。
      </p>
      <Input aria-label="服务端名称" placeholder="名称，如 exa" value={name} onChange={(e) => setName(e.target.value)} required />
      <Input aria-label="Endpoint URL" placeholder="https://mcp.example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} required spellCheck={false} />
      <Input aria-label="凭据环境变量名（可选）" placeholder="凭据环境变量名（可选），如 EXA_API_KEY" value={tokenEnv} onChange={(e) => setTokenEnv(e.target.value)} spellCheck={false} />
      <StatusLine error={error} />
      <div className="flex gap-2">
        <Button type="submit" variant="outline" size="sm" disabled={busy || !name.trim() || !url.trim()}>
          {busy ? "校验并安装…" : "校验并安装"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          取消
        </Button>
      </div>
    </form>
  );
}

// ---- panel -----------------------------------------------------------------------------------------------------------

type FormKind = "skill" | "skill-file" | "mcp" | undefined;

function IntegrationsPanel({ bot, bots }: PanelContext) {
  const ctx = useContext(WorkspaceContext);
  const ws = ctx?.workspace;
  const [info, setInfo] = useState<IntegrationsInfo>();
  const [installs, setInstalls] = useState<IntegrationInstall[]>();
  const [form, setForm] = useState<FormKind>();
  const [preview, setPreview] = useState<{ name: string; content: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  // The skill-file install scans one session's cwd. On the workspace home there is no selected session, so the
  // user picks one explicitly — never silently reuse whatever chat happened to be open. Bots arriving through
  // ctx are already scoped to this workspace by the App's own selection, except none on the home page.
  const sessions = bots.filter((b) => b.workspaceId === ws?.id || (ws?.botId !== undefined && b.id === ws.botId));
  const [pickedBotId, setPickedBotId] = useState<string>();
  const effectiveBot = bot ?? sessions.find((b) => b.id === pickedBotId);

  const wsId = ws?.id;
  const load = useCallback(async () => {
    if (!wsId) return;
    try {
      const [i, l] = await Promise.all([integrationsApi.info(), integrationsApi.list(wsId)]);
      setInfo(i);
      setInstalls(l.installs);
    } catch (e) {
      setError(describeError(e));
    }
    // wsId, not ws: the App refreshes the workspace object every few seconds; depending on the object would
    // reset the user's explicit session pick (pickedBotId) and any open form on every poll tick.
  }, [wsId]);

  useEffect(() => {
    setInstalls(undefined);
    setPreview(undefined);
    setError(undefined);
    setNotice(undefined);
    setPickedBotId(undefined);
    void load();
  }, [load]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (i: IntegrationInstall) =>
    run(async () => {
      const r = await integrationsApi.setEnabled(ws!.id, i.id, !i.enabled);
      setNotice(
        r.applied.failed.length > 0
          ? `已${i.enabled ? "停用" : "启用"}；部分会话未能即时生效：${r.applied.failed.join("；")}`
          : `已${i.enabled ? "停用" : "启用"}；${r.applied.configured} 个会话已更新（busy 会话下个 turn 生效）`,
      );
    });

  const remove = (i: IntegrationInstall) =>
    run(async () => {
      await integrationsApi.uninstall(ws!.id, i.id);
      setNotice(`已卸载 ${i.name}`);
    });

  const doPreview = async (i: IntegrationInstall) => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await integrationsApi.skillContent(ws!.id, i.id);
      setPreview({ name: i.name, content: r.content });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full space-y-3 overflow-y-auto p-3">
      <section aria-label="已安装集成"><Card size="sm" className="gap-2 text-xs">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-foreground">已安装（{ws ? ws.name : "未选工作区"}）</h3>
          <Button type="button" variant="outline" size="xs" disabled={!ws || busy} onClick={() => void load()}>
            刷新
          </Button>
        </div>
        <StatusLine error={error} notice={notice} />
        {bot?.integrationError && <p role="alert">{bot.integrationError}</p>}
        {!ws && <p className="text-muted-foreground">选择一个工作区后管理集成。</p>}
        {installs && installs.length === 0 && <p className="text-muted-foreground">此工作区还没有安装任何集成。</p>}
        {installs && installs.length > 0 && (
          <ul className="space-y-1">
            {installs.map((i) => (
              <InstallRow key={i.id} install={i} busy={busy} onToggle={(x) => void toggle(x)} onRemove={(x) => void remove(x)} onPreview={(x) => void doPreview(x)} />
            ))}
          </ul>
        )}
        {preview && (
          <div className="space-y-1">
            <p className="text-muted-foreground">{preview.name}（安装快照）</p>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted p-2 text-foreground" data-testid="skill-snapshot">
              {preview.content}
            </pre>
            <Button type="button" variant="outline" size="xs" onClick={() => setPreview(undefined)}>
              关闭预览
            </Button>
          </div>
        )}
      </Card></section>

      <section aria-label="安装"><Card size="sm" className="gap-2 text-xs">
        <h3 className="font-semibold text-foreground">安装</h3>
        <p className="text-muted-foreground">Skill 与 MCP 供 Pi Agent 使用：skill 进系统上下文并由 load_skill 加载；MCP 工具以 mcp__ 前缀进工具集，每次调用需审批。</p>
        {!form && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" disabled={!ws || busy} onClick={() => setForm("skill")}>
                安装 Skill（粘贴）
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={!ws || !effectiveBot || busy} onClick={() => setForm("skill-file")}>
                从工作区 SKILL.md 安装
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={!ws || busy} onClick={() => setForm("mcp")}>
                添加 MCP 服务端
              </Button>
            </div>
            {!bot && ws && (
              sessions.length === 0 ? (
                <p className="text-muted-foreground">此工作区还没有会话；「从工作区 SKILL.md 安装」需要一个会话目录来扫描。</p>
              ) : (
                <label className="flex items-center gap-2">
                  <span className="text-muted-foreground">扫描会话</span>
                  <select
                    aria-label="选择要扫描 SKILL.md 的会话"
                    className="h-7 rounded border border-input bg-transparent px-1.5 text-xs text-foreground"
                    value={pickedBotId ?? ""}
                    onChange={(e) => setPickedBotId(e.target.value || undefined)}
                  >
                    <option value="">选择一个会话…</option>
                    {sessions.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </label>
              )
            )}
          </div>
        )}
        {form === "skill" && ws && <InstallSkillForm wsId={ws.id} onDone={() => { setForm(undefined); void load(); setNotice("Skill 已安装"); }} onCancel={() => setForm(undefined)} />}
        {form === "skill-file" && ws && <InstallSkillFileForm wsId={ws.id} bot={effectiveBot} onDone={() => { setForm(undefined); void load(); setNotice("Skill 已安装"); }} onCancel={() => setForm(undefined)} />}
        {form === "mcp" && ws && <InstallMcpForm wsId={ws.id} onDone={() => { setForm(undefined); void load(); setNotice("MCP 服务端已安装"); }} onCancel={() => setForm(undefined)} />}
      </Card></section>

      <section aria-label="说明"><Card size="sm" className="gap-2 text-xs">
        <h3 className="font-semibold text-foreground">协议与未支持项</h3>
        <p className="text-muted-foreground">
          MCP：Streamable HTTP、协议 {info?.mcp.protocolVersion ?? "2025-03-26"}（最小 JSON-RPC 客户端，非完整 SDK）；stdio/SSE transport、OAuth 未支持。
          Slack：{info?.slack.reason ?? "未配置、未实现。"}
        </p>
      </Card></section>
    </div>
  );
}

export const integrationsPanel: PanelDefinition = {
  id: "integrations",
  title: "Integrations",
  icon: "globe",
  Component: IntegrationsPanel,
};
