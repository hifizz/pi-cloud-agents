// Loop editor (Issue14 Phase1): three sections — Trigger / Instructions / Capabilities & access — plus Save.
// Create (loopId undefined) and edit both go through this form; edit PATCHes (server bumps the version).
import { useCallback, useEffect, useState } from "react";
import { describeError } from "../lib/workspaces";
import {
  loopsApi,
  type Loop,
  type LoopCapabilities,
  type LoopCodeLevel,
  type LoopInput,
  type LoopReasoning,
  type LoopTriggerKind,
} from "../lib/loops";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";

const localMinute = (ms: number) => {
  const date = new Date(ms);
  return new Date(ms - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

const FREQ_LABEL = { hourly: "每小时", daily: "每天", weekly: "每周", monthly: "每月", yearly: "每年" } as const;

export interface LoopEditorProps {
  workspaceId: string;
  /** Loop being edited; undefined = create a new loop. */
  loopId?: string;
  onSaved: (loop: Loop) => void;
  onCancel: () => void;
  /** Server-returned webhook secret shown once after save (create-with-webhook or rotate). */
}

export function LoopEditor({ workspaceId, loopId, onSaved, onCancel }: LoopEditorProps) {
  const [loaded, setLoaded] = useState<Loop>();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [kind, setKind] = useState<LoopTriggerKind>("manual");
  const [freq, setFreq] = useState<keyof typeof FREQ_LABEL>("daily");
  const [interval, setInterval] = useState(1);
  const [at, setAt] = useState("09:00");
  const [tz, setTz] = useState("UTC");
  const [startAt, setStartAt] = useState("");
  const [days, setDays] = useState<number[]>([1]);
  const [ghEvents, setGhEvents] = useState<string[]>(["opened"]);
  const [ghFilterLabel, setGhFilterLabel] = useState("");
  const [ghFilterBranch, setGhFilterBranch] = useState("");
  const [code, setCode] = useState<LoopCodeLevel>("read");
  const [web, setWeb] = useState(false);
  const [scopeToTrigger, setScopeToTrigger] = useState(true);
  const [github, setGithub] = useState<LoopCapabilities["github"]>({ comment: false, label: false, openIssue: false, openPr: false });
  const [reasoning, setReasoning] = useState<LoopReasoning>("auto");
  const [saving, setSaving] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [error, setError] = useState<string>();
  // Once-only webhook secret after create-with-webhook or rotate. The editor stays open on a dedicated
  // reveal/copy/acknowledge step — navigating away before the user has it loses the secret forever.
  const [pendingSave, setPendingSave] = useState<{ loop: Loop; secret: string }>();
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!loopId) return;
    let dead = false;
    loopsApi
      .get(loopId)
      .then((loop) => {
        if (dead) return;
        setLoaded(loop);
        setName(loop.name);
        setDescription(loop.description ?? "");
        setInstructions(loop.instructions);
        setKind(loop.trigger.kind);
        if (loop.trigger.kind === "schedule") {
          const s = loop.trigger as unknown as { freq: keyof typeof FREQ_LABEL; interval: number; at?: string; tz: string; startAt: number; days?: number[] };
          setFreq(s.freq);
          setInterval(s.interval);
          setAt(s.at ?? "09:00");
          setTz(s.tz);
          setStartAt(localMinute(s.startAt));
          setDays(s.days ?? [1]);
        }
        setCode(loop.capabilities.code);
        setWeb(loop.capabilities.web);
        setScopeToTrigger(loop.capabilities.scopeToTrigger);
        setGithub(loop.capabilities.github);
        const t = loop.trigger as { kind: LoopTriggerKind; events?: string[]; filters?: { label?: string; branch?: string } };
        if (t.kind === "github_issue" || t.kind === "github_pr") {
          setGhEvents(t.events?.length ? t.events : ["opened"]);
          setGhFilterLabel(t.filters?.label ?? "");
          setGhFilterBranch(t.filters?.branch ?? "");
        }
        setReasoning(loop.reasoning);
      })
      .catch((e) => !dead && setError(describeError(e)));
    return () => {
      dead = true;
    };
  }, [loopId]);

  const buildTrigger = useCallback((): LoopInput["trigger"] => {
    if (kind === "schedule") {
      const t: Record<string, unknown> = { kind, freq, interval, tz };
      if (freq !== "hourly") t.at = at;
      if (freq === "weekly") t.days = days;
      const original = loaded?.trigger.kind === "schedule" ? loaded.trigger.startAt : undefined;
      t.startAt = typeof original === "number" && startAt === localMinute(original)
        ? original : startAt ? Date.parse(startAt) : Date.now() + 60_000;
      return t as LoopInput["trigger"];
    }
    if (kind === "github_issue" || kind === "github_pr") {
      const filters: Record<string, string> = {};
      if (ghFilterLabel.trim()) filters.label = ghFilterLabel.trim();
      if (ghFilterBranch.trim()) filters.branch = ghFilterBranch.trim();
      return { kind, events: ghEvents, ...(Object.keys(filters).length ? { filters } : {}) } as LoopInput["trigger"];
    }
    return { kind };
  }, [kind, freq, interval, tz, at, days, startAt, loaded, ghEvents, ghFilterLabel, ghFilterBranch]);

  const ackSecret = () => {
    if (!pendingSave) return;
    const out = pendingSave;
    setPendingSave(undefined);
    setRevealed(false);
    setCopied(false);
    onSaved(out.loop); // only now navigate: the user confirmed they have the secret
  };

  const copySecret = async () => {
    if (!pendingSave) return;
    try {
      await navigator.clipboard.writeText(pendingSave.secret);
      setCopied(true);
    } catch {
      setCopied(false); // clipboard unavailable (non-secure context): the user can still select the revealed text
    }
  };

  const rotate = async () => {
    if (!loopId || rotating) return;
    setRotating(true);
    setError(undefined);
    try {
      const { webhookSecret } = await loopsApi.rotateSecret(loopId);
      // Keep the editor open on the same reveal/ack step; acknowledging also leaves the editor (the
      // loop itself is unchanged — secret rotation is a live swap, not a versioned edit).
      const loop = loaded ?? (await loopsApi.get(loopId));
      setPendingSave({ loop, secret: webhookSecret });
      setRevealed(false);
      setCopied(false);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setRotating(false);
    }
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(undefined);
    const capabilities: Partial<LoopCapabilities> = { code, web, scopeToTrigger, github };
    const input: LoopInput = { name, description: description || undefined, instructions, trigger: buildTrigger(), capabilities, reasoning };
    try {
      const out = loopId ? await loopsApi.update(loopId, input) : await loopsApi.create(workspaceId, input);
      if (out.webhookSecret) {
        // Do NOT navigate yet: the secret is shown exactly once — the user must acknowledge it first.
        setPendingSave({ loop: out.loop, secret: out.webhookSecret });
        setRevealed(false);
        setCopied(false);
        return;
      }
      onSaved(out.loop);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSaving(false);
    }
  };

  // Native <select> stays for trigger/freq/reasoning: tests drive them with selectOptions.
  const selectCls =
    "mt-1 h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";
  const labelCls = "text-xs font-medium text-muted-foreground";

  return (
    <form
      aria-label="Loop 编辑器"
      data-testid="loop-editor"
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <section aria-label="基本信息" className="space-y-2">
        <div>
          <Label htmlFor="loop-name" className={labelCls}>
            名称（≤64 字）
          </Label>
          <Input id="loop-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} required className="mt-1" />
        </div>
        <div>
          <Label htmlFor="loop-desc" className={labelCls}>
            描述（≤255 字，可选）
          </Label>
          <Input id="loop-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={255} className="mt-1" />
        </div>
      </section>

      <section aria-label="Trigger" className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Trigger</h4>
        <div>
          <Label htmlFor="loop-trigger-kind" className={labelCls}>
            触发方式
          </Label>
          <select id="loop-trigger-kind" value={kind} onChange={(e) => setKind(e.target.value as LoopTriggerKind)} className={selectCls} data-testid="trigger-kind">
            <option value="manual">手动 Run now</option>
            <option value="schedule">定时</option>
            <option value="webhook">Webhook</option>
            <option value="github_issue">GitHub Issue</option>
            <option value="github_pr">GitHub PR</option>
          </select>
        </div>
        {(kind === "github_issue" || kind === "github_pr") && (
          <div className="space-y-2" data-testid="github-trigger">
            <div>
              <span className={`block ${labelCls}`}>事件（至少一个）</span>
              <div className="mt-1 flex flex-wrap gap-1" role="group" aria-label="GitHub 事件">
                {(kind === "github_issue"
                  ? ["opened", "labeled", "closed", "assigned", "commented"]
                  : ["opened", "ready_for_review", "labeled", "merged", "checks_failed", "checks_passed", "review_submitted", "push", "commented"]
                ).map((e) => (
                  <Button
                    key={e}
                    type="button"
                    variant={ghEvents.includes(e) ? "secondary" : "outline"}
                    size="xs"
                    aria-pressed={ghEvents.includes(e)}
                    onClick={() => setGhEvents((cur) => (cur.includes(e) ? cur.filter((x) => x !== e) : [...cur, e]))}
                    className={ghEvents.includes(e) ? "border-ring" : undefined}
                  >
                    {e}
                  </Button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="loop-gh-label" className={labelCls}>
                  Label 过滤（可选）
                </Label>
                <Input id="loop-gh-label" value={ghFilterLabel} onChange={(e) => setGhFilterLabel(e.target.value)} placeholder="bug" className="mt-1" />
              </div>
              <div>
                <Label htmlFor="loop-gh-branch" className={labelCls}>
                  分支过滤（PR base，可选）
                </Label>
                <Input id="loop-gh-branch" value={ghFilterBranch} onChange={(e) => setGhFilterBranch(e.target.value)} placeholder="main" className="mt-1" />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              GitHub 事件经 Webhook（TARSBOT_GITHUB_WEBHOOK_SECRET）或轮询补齐；同一事件跨通道去重，条件类事件按“开始匹配”语义只触发一次。
            </p>
          </div>
        )}
        {kind === "schedule" && (
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label htmlFor="loop-freq" className={labelCls}>
                频率
              </Label>
              <select id="loop-freq" value={freq} onChange={(e) => setFreq(e.target.value as keyof typeof FREQ_LABEL)} className={selectCls}>
                {Object.entries(FREQ_LABEL).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="loop-interval" className={labelCls}>
                间隔
              </Label>
              <Input id="loop-interval" type="number" min={1} value={interval} onChange={(e) => setInterval(Math.max(1, Number(e.target.value) || 1))} className="mt-1" />
            </div>
            {freq !== "hourly" && (
              <div>
                <Label htmlFor="loop-at" className={labelCls}>
                  时间（HH:MM）
                </Label>
                <Input id="loop-at" value={at} onChange={(e) => setAt(e.target.value)} placeholder="09:00" pattern="[0-2][0-9]:[0-5][0-9]" className="mt-1" />
              </div>
            )}
            <div>
              <Label htmlFor="loop-tz" className={labelCls}>
                时区
              </Label>
              <Input id="loop-tz" value={tz} onChange={(e) => setTz(e.target.value)} placeholder="UTC" className="mt-1" />
            </div>
            {freq === "weekly" && (
              <div className="col-span-2">
                <span className={`block ${labelCls}`}>星期</span>
                <div className="mt-1 flex gap-1">
                  {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                    <Button
                      key={d}
                      type="button"
                      variant={days.includes(d) ? "secondary" : "outline"}
                      size="icon-sm"
                      aria-pressed={days.includes(d)}
                      onClick={() => setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort()))}
                      className={days.includes(d) ? "border-ring text-xs" : "text-xs"}
                    >
                      {["日", "一", "二", "三", "四", "五", "六"][d]}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            <div className="col-span-2">
              <Label htmlFor="loop-start" className={labelCls}>
                首次运行（按本机时区选择；留空 = 下一分钟，须晚于当前）
              </Label>
              <Input id="loop-start" type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} className="mt-1" />
            </div>
          </div>
        )}
        {kind === "webhook" && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground" data-testid="webhook-note">
              保存后服务端会生成一个 Bearer secret（只显示一次）。也支持 Standard Webhooks 签名（需服务端配置 HMAC key）。去重按 Webhook-Id。
            </p>
            {loopId && loaded?.hasWebhookSecret && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void rotate()}
                disabled={rotating || saving}
                data-testid="rotate-secret"
              >
                {rotating ? "轮换中…" : "轮换 webhook secret（旧 secret 立即失效）"}
              </Button>
            )}
          </div>
        )}
      </section>

      <section aria-label="Instructions" className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Instructions</h4>
        <Textarea
          aria-label="Loop 指令"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          required
          rows={6}
          placeholder="描述这个 Loop 每次运行要做什么…"
          className="resize-y"
          data-testid="loop-instructions"
        />
      </section>

      <section aria-label="Capabilities & access" className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Capabilities &amp; access</h4>
        <div>
          <span className={`block ${labelCls}`}>代码访问</span>
          <div className="mt-1 flex gap-2" role="radiogroup" aria-label="代码访问级别">
            {(
              [
                ["none", "无（不检出代码）"],
                ["read", "只读（detached worktree）"],
                ["readwrite", "读写（独立 loops/* 分支）"],
              ] as [LoopCodeLevel, string][]
            ).map(([v, l]) => (
              <label key={v} className={`flex-1 cursor-pointer rounded-md border px-2 py-1.5 text-center text-xs ${code === v ? "border-ring bg-accent text-foreground" : "border-input text-muted-foreground"}`}>
                <input type="radio" name="loop-code" value={v} checked={code === v} onChange={() => setCode(v)} className="sr-only" />
                {l}
              </label>
            ))}
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={web} onChange={(e) => setWeb(e.target.checked)} className="size-3.5" />
          Web access（web_search；会话历史搜索不受此开关影响）
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={scopeToTrigger} onChange={(e) => setScopeToTrigger(e.target.checked)} className="size-3.5" />
          只允许修改触发它的对象（scopeToTrigger）
        </label>
        <fieldset className="space-y-1" aria-label="GitHub 写权限">
          <legend className={labelCls}>GitHub 写权限（每次调用仍需审批）</legend>
          {([ ["comment", "评论"], ["label", "添加 label"], ["openIssue", "创建 Issue"], ["openPr", "推送本次分支并创建 PR"] ] as const).map(([key, label]) => (
            <label key={key} className="flex gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={github[key]} onChange={e => setGithub({ ...github, [key]: e.target.checked })} />{label}
            </label>
          ))}
        </fieldset>
        <div>
          <Label htmlFor="loop-reasoning" className={labelCls}>
            Reasoning level
          </Label>
          <select id="loop-reasoning" value={reasoning} onChange={(e) => setReasoning(e.target.value as LoopReasoning)} className={selectCls}>
            <option value="auto">Auto</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>
      </section>

      {pendingSave && (
        <section
          aria-label="Webhook secret"
          className="space-y-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2"
          data-testid="webhook-secret"
        >
          <p className="text-xs font-medium text-warn">Webhook secret — 只显示这一次。复制并保存后再继续。</p>
          {revealed ? (
            <code className="block select-all break-all rounded border border-border bg-muted px-2 py-1.5 font-mono text-xs text-foreground" data-testid="secret-value">
              {pendingSave.secret}
            </code>
          ) : (
            <Button type="button" variant="outline" size="sm" onClick={() => setRevealed(true)} data-testid="reveal-secret">
              显示 secret
            </Button>
          )}
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => void copySecret()} data-testid="copy-secret">
              {copied ? "已复制 ✓" : "复制"}
            </Button>
            <Button type="button" size="sm" onClick={ackSecret} disabled={!revealed && !copied} data-testid="ack-secret">
              我已保存好 secret，继续
            </Button>
          </div>
        </section>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={saving || pendingSave !== undefined}>
          取消
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={saving || pendingSave !== undefined || !name.trim() || !instructions.trim() || (loopId !== undefined && !loaded)}
          data-testid="loop-save"
        >
          {saving ? "保存中…" : loopId ? "保存" : "创建"}
        </Button>
      </div>
    </form>
  );
}
