// Integrations panel (AMP13-integrations, revised): install / enable / disable / uninstall Skills and
// MCP endpoints FOR THE PI AGENT, scoped to the selected workspace. This is an INSTALL UI — not a
// human-call/paste panel. Installed skills appear in the agent's system context and load via the
// load_skill tool; installed MCP servers expose real tools (mcp__*) to the model, each call gated by
// the existing approval flow.
import { useCallback, useContext, useEffect, useState } from "react";
import { request } from "../../lib/api";
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

const integrationsApi = {
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

const btn =
  "rounded-md border border-line-strong px-2 py-1 text-xs text-fg-dim hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40";
const field =
  "w-full rounded-md border border-line-strong bg-field px-2 py-1.5 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-2 focus-visible:outline-accent";
const sectionCls = "rounded-lg border border-line bg-raised p-3 text-xs space-y-2";

function StatusLine({ error, notice }: { error?: string; notice?: string }) {
  return (
    <>
      {error && (
        <p role="alert" className="text-bad">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-fg-muted">
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
    <li className="rounded-md border border-line bg-field p-2" data-testid={`install-${install.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium text-fg">
            {install.name}
            <span className="ml-2 rounded-sm bg-raised px-1 py-0.5 text-[10px] uppercase tracking-wide text-fg-muted">{install.kind}</span>
            {!install.enabled && <span className="ml-1 rounded-sm bg-raised px-1 py-0.5 text-[10px] uppercase tracking-wide text-bad">停用</span>}
          </p>
          {install.description && <p className="mt-0.5 truncate text-fg-muted">{install.description}</p>}
          <p className="mt-0.5 text-fg-muted">
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
            <p className="mt-0.5 truncate font-mono text-[10px] text-fg-muted" title={install.tools.map((t) => t.name).join(", ")}>
              {install.tools.map((t) => t.name).join(", ")}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <div className="flex gap-1">
            {install.kind === "skill" && (
              <button type="button" className={btn} disabled={busy} onClick={() => onPreview(install)} aria-label={`预览 ${install.name}`}>
                预览
              </button>
            )}
            <button type="button" className={btn} disabled={busy} onClick={() => onToggle(install)} aria-label={install.enabled ? `停用 ${install.name}` : `启用 ${install.name}`}>
              {install.enabled ? "停用" : "启用"}
            </button>
            <button type="button" className={btn} disabled={busy} onClick={() => onRemove(install)} aria-label={`卸载 ${install.name}`}>
              卸载
            </button>
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
    <form onSubmit={submit} aria-label="安装 Skill" className="space-y-2 rounded-md border border-line bg-field p-2">
      <p className="text-fg-muted">粘贴 SKILL.md 内容（含 name/description frontmatter）。保存为快照，安装后 Pi 通过 load_skill 调用。</p>
      <input aria-label="Skill 名称（可选，frontmatter 优先）" placeholder="名称（可选，frontmatter 优先）" className={field} value={name} onChange={(e) => setName(e.target.value)} />
      <input aria-label="描述（可选）" placeholder="描述（可选）" className={field} value={desc} onChange={(e) => setDesc(e.target.value)} />
      <textarea aria-label="SKILL.md 内容" placeholder="---\nname: ...\ndescription: ...\n---\n内容" className={field} rows={6} value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} required />
      <StatusLine error={error} />
      <div className="flex gap-2">
        <button type="submit" className={btn} disabled={busy || !content.trim()}>
          {busy ? "安装中…" : "安装 Skill"}
        </button>
        <button type="button" className={btn} onClick={onCancel}>
          取消
        </button>
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
    <div aria-label="从工作区文件安装" className="space-y-2 rounded-md border border-line bg-field p-2">
      <p className="text-fg-muted">会话目录中的 SKILL.md（真实文件，安装为快照，不执行内容）。</p>
      {!bot && <p className="text-fg-muted">选择一个会话后才能扫描工作区文件。</p>}
      {skills && skills.length === 0 && <p className="text-fg-muted">会话目录内没有 SKILL.md。</p>}
      <ul className="space-y-1">
        {(skills ?? []).map((s) => (
          <li key={s.path} className="flex items-center gap-2">
            <button type="button" className={`${btn} min-w-0 flex-1 truncate text-left font-mono ${picked === s.path ? "border-accent" : ""}`} onClick={() => void read(s.path)} title={s.path}>
              {s.path}
            </button>
          </li>
        ))}
      </ul>
      {preview && <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-raised p-2 text-fg">{preview}</pre>}
      <StatusLine error={error} />
      <div className="flex gap-2">
        <button type="button" className={btn} disabled={busy || !picked} onClick={() => void install()}>
          {busy ? "安装中…" : "安装选中文件"}
        </button>
        <button type="button" className={btn} onClick={onCancel}>
          取消
        </button>
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
    <form onSubmit={submit} aria-label="添加 MCP 服务端" className="space-y-2 rounded-md border border-line bg-field p-2">
      <p className="text-fg-muted">
        命名 HTTP endpoint（公网 http(s)，Streamable HTTP / 协议 2025-03-26）。安装时真实 initialize + tools/list 校验。
        凭据只填环境变量名（Bearer token），明文密钥不接收、不保存。OAuth 未支持。
      </p>
      <input aria-label="服务端名称" placeholder="名称，如 exa" className={field} value={name} onChange={(e) => setName(e.target.value)} required />
      <input aria-label="Endpoint URL" placeholder="https://mcp.example.com/mcp" className={field} value={url} onChange={(e) => setUrl(e.target.value)} required spellCheck={false} />
      <input aria-label="凭据环境变量名（可选）" placeholder="凭据环境变量名（可选），如 EXA_API_KEY" className={field} value={tokenEnv} onChange={(e) => setTokenEnv(e.target.value)} spellCheck={false} />
      <StatusLine error={error} />
      <div className="flex gap-2">
        <button type="submit" className={btn} disabled={busy || !name.trim() || !url.trim()}>
          {busy ? "校验并安装…" : "校验并安装"}
        </button>
        <button type="button" className={btn} onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}

// ---- panel -----------------------------------------------------------------------------------------------------------

type FormKind = "skill" | "skill-file" | "mcp" | undefined;

function IntegrationsPanel({ bot }: PanelContext) {
  const ctx = useContext(WorkspaceContext);
  const ws = ctx?.workspace;
  const [info, setInfo] = useState<IntegrationsInfo>();
  const [installs, setInstalls] = useState<IntegrationInstall[]>();
  const [form, setForm] = useState<FormKind>();
  const [preview, setPreview] = useState<{ name: string; content: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const load = useCallback(async () => {
    if (!ws) return;
    try {
      const [i, l] = await Promise.all([integrationsApi.info(), integrationsApi.list(ws.id)]);
      setInfo(i);
      setInstalls(l.installs);
    } catch (e) {
      setError(describeError(e));
    }
  }, [ws]);

  useEffect(() => {
    setInstalls(undefined);
    setPreview(undefined);
    setError(undefined);
    setNotice(undefined);
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
      <section aria-label="已安装集成" className={sectionCls}>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-fg">已安装（{ws ? ws.name : "未选工作区"}）</h3>
          <button type="button" className={btn} disabled={!ws || busy} onClick={() => void load()}>
            刷新
          </button>
        </div>
        <StatusLine error={error} notice={notice} />
        {bot?.integrationError && <p role="alert">{bot.integrationError}</p>}
        {!ws && <p className="text-fg-muted">选择一个工作区后管理集成。</p>}
        {installs && installs.length === 0 && <p className="text-fg-muted">此工作区还没有安装任何集成。</p>}
        {installs && installs.length > 0 && (
          <ul className="space-y-1">
            {installs.map((i) => (
              <InstallRow key={i.id} install={i} busy={busy} onToggle={(x) => void toggle(x)} onRemove={(x) => void remove(x)} onPreview={(x) => void doPreview(x)} />
            ))}
          </ul>
        )}
        {preview && (
          <div className="space-y-1">
            <p className="text-fg-muted">{preview.name}（安装快照）</p>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-field p-2 text-fg" data-testid="skill-snapshot">
              {preview.content}
            </pre>
            <button type="button" className={btn} onClick={() => setPreview(undefined)}>
              关闭预览
            </button>
          </div>
        )}
      </section>

      <section aria-label="安装" className={sectionCls}>
        <h3 className="font-semibold text-fg">安装</h3>
        <p className="text-fg-muted">Skill 与 MCP 供 Pi Agent 使用：skill 进系统上下文并由 load_skill 加载；MCP 工具以 mcp__ 前缀进工具集，每次调用需审批。</p>
        {!form && (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btn} disabled={!ws || busy} onClick={() => setForm("skill")}>
              安装 Skill（粘贴）
            </button>
            <button type="button" className={btn} disabled={!ws || !bot || busy} onClick={() => setForm("skill-file")}>
              从工作区 SKILL.md 安装
            </button>
            <button type="button" className={btn} disabled={!ws || busy} onClick={() => setForm("mcp")}>
              添加 MCP 服务端
            </button>
          </div>
        )}
        {form === "skill" && ws && <InstallSkillForm wsId={ws.id} onDone={() => { setForm(undefined); void load(); setNotice("Skill 已安装"); }} onCancel={() => setForm(undefined)} />}
        {form === "skill-file" && ws && <InstallSkillFileForm wsId={ws.id} bot={bot} onDone={() => { setForm(undefined); void load(); setNotice("Skill 已安装"); }} onCancel={() => setForm(undefined)} />}
        {form === "mcp" && ws && <InstallMcpForm wsId={ws.id} onDone={() => { setForm(undefined); void load(); setNotice("MCP 服务端已安装"); }} onCancel={() => setForm(undefined)} />}
      </section>

      <section aria-label="说明" className={sectionCls}>
        <h3 className="font-semibold text-fg">协议与未支持项</h3>
        <p className="text-fg-muted">
          MCP：Streamable HTTP、协议 {info?.mcp.protocolVersion ?? "2025-03-26"}（最小 JSON-RPC 客户端，非完整 SDK）；stdio/SSE transport、OAuth 未支持。
          Slack：{info?.slack.reason ?? "未配置、未实现。"}
        </p>
      </section>
    </div>
  );
}

export const integrationsPanel: PanelDefinition = {
  id: "integrations",
  title: "Integrations",
  icon: "globe",
  Component: IntegrationsPanel,
};
