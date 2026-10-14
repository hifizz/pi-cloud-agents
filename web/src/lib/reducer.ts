// The only module that reads the pi-durable wire protocol (watchEvents frames).
// Pure: reduce(vm, frame) -> vm. A `snapshot` frame rebuilds everything; `events` frames apply incrementally.
import type {
  AgentInfo,
  ChatMessage,
  ConversationVM,
  ImagePart,
  InboxItem,
  Part,
  TextPart,
  ToolPart,
  Usage,
} from "../types";

// ---- wire shapes (loose on purpose; the protocol is experimental) ----
/* eslint-disable @typescript-eslint/no-explicit-any */
type Wire = any;

export interface SnapshotFrame {
  type: "snapshot";
  entries?: Wire[];
  run?: { inputs: unknown[] };
  generation?: { attempt?: number; message?: Wire };
  tools?: Wire[];
  compactions?: Wire[];
  inbox?: Wire[];
  agent?: Wire;
  usage?: Wire;
}
export interface EventsFrame {
  type: "events";
  events: Wire[];
}
export interface ErrorFrame {
  type: "error";
  error: string;
}
export type Frame = SnapshotFrame | EventsFrame | ErrorFrame;

export const PENDING_ID = "pending";
const HARNESS_BLOCK = /^<harness>[\s\S]*<\/harness>$/;

// ---- construction ----
export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

export function emptyVM(): ConversationVM {
  return { messages: [], busy: false, inbox: [], usage: emptyUsage(), agent: {}, compacting: 0, toolStash: {} };
}

function usageOf(state: Wire): Usage {
  const total = emptyUsage();
  if (!state) return total;
  for (const bucket of [state.models, state.tools]) {
    if (!bucket) continue;
    for (const u of Object.values<Wire>(bucket)) {
      total.input += u.input ?? 0;
      total.output += u.output ?? 0;
      total.cacheRead += u.cacheRead ?? 0;
      total.cacheWrite += u.cacheWrite ?? 0;
      total.totalTokens += u.totalTokens ?? 0;
      total.cost += u.cost?.total ?? 0;
    }
  }
  return total;
}

function agentOf(agent: Wire): AgentInfo {
  const out: AgentInfo = {};
  if (agent?.model?.provider) out.provider = agent.model.provider;
  if (agent?.model?.modelId) out.modelId = agent.model.modelId;
  if (agent?.thinkingLevel) out.thinkingLevel = agent.thinkingLevel;
  if (agent?.cwd) out.cwd = agent.cwd;
  return out;
}

function inboxOf(items: Wire[] | undefined): InboxItem[] {
  return (items ?? []).map((i) => ({ id: i.id, mode: String(i.mode ?? "") }));
}

// ---- content conversion ----
function userParts(content: Wire): Part[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  const parts: Part[] = [];
  for (const block of content ?? []) {
    if (block?.type === "text") parts.push({ type: "text", text: block.text ?? "" });
    else if (block?.type === "image") parts.push({ type: "image", data: block.data ?? "", mimeType: block.mimeType ?? "image/png" });
  }
  return parts;
}

function newToolPart(id: string, name: string, args: Wire): ToolPart {
  return { type: "tool", id, name, args: args && typeof args === "object" ? args : {}, status: "running", output: "" };
}

/** Convert assistant content blocks to parts (1:1 with block indexes), carrying over tool state from `prev`/stash. */
function assistantParts(content: Wire[] | undefined, prev: Part[] | undefined, stash: Record<string, ToolPart>): Part[] {
  const prevTools = new Map<string, ToolPart>();
  for (const p of prev ?? []) if (p.type === "tool") prevTools.set(p.id, p);
  return (content ?? []).map((block): Part => {
    switch (block?.type) {
      case "text":
        return { type: "text", text: block.text ?? "" };
      case "thinking":
        return { type: "thinking", text: block.thinking ?? "" };
      case "toolCall": {
        const base = prevTools.get(block.id) ?? stash[block.id];
        if (base) {
          delete stash[block.id];
          return { ...base, name: block.name ?? base.name, args: block.arguments ?? base.args };
        }
        return newToolPart(block.id, block.name, block.arguments);
      }
      default:
        return { type: "text", text: "" };
    }
  });
}

function blockToPart(block: Wire, prev?: Part): Part {
  if (block?.type === "thinking") return { type: "thinking", text: block.thinking ?? "" };
  if (block?.type === "toolCall") {
    const base = prev?.type === "tool" && prev.id === block.id ? prev : undefined;
    return base ? { ...base, name: block.name ?? base.name, args: block.arguments ?? base.args } : newToolPart(block.id, block.name, block.arguments);
  }
  return { type: "text", text: block?.text ?? "" };
}

// ---- small immutable helpers ----
function upsertMessage(messages: ChatMessage[], msg: ChatMessage): ChatMessage[] {
  const i = messages.findIndex((m) => m.id === msg.id);
  if (i >= 0) {
    const next = messages.slice();
    next[i] = msg;
    return next;
  }
  // Keep a streaming message last.
  const last = messages[messages.length - 1];
  if (last?.pending && msg.role !== "assistant") return [...messages.slice(0, -1), msg, last];
  return [...messages, msg];
}

function pendingIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.pending && m.role === "assistant") return i;
  }
  return -1;
}

function replaceAt<T>(list: T[], i: number, value: T): T[] {
  const next = list.slice();
  next[i] = value;
  return next;
}

/** Apply `fn` to the tool part `id` (newest match wins). Returns undefined when no such part exists. */
function mapTool(vm: ConversationVM, id: string, fn: (p: ToolPart) => ToolPart): ConversationVM | undefined {
  for (let mi = vm.messages.length - 1; mi >= 0; mi--) {
    const msg = vm.messages[mi];
    const pi = msg.parts.findIndex((p) => p.type === "tool" && p.id === id);
    if (pi < 0) continue;
    const part = msg.parts[pi] as ToolPart;
    const parts = replaceAt(msg.parts, pi, fn(part));
    return { ...vm, messages: replaceAt(vm.messages, mi, { ...msg, parts }) };
  }
  return undefined;
}

/** Like mapTool, but when the part does not exist yet, keep the change in the stash for its assistant message. */
function mapToolOrStash(vm: ConversationVM, id: string, name: string, fn: (p: ToolPart) => ToolPart): ConversationVM {
  const hit = mapTool(vm, id, fn);
  if (hit) return hit;
  const base = vm.toolStash[id] ?? newToolPart(id, name, {});
  return { ...vm, toolStash: { ...vm.toolStash, [id]: fn(base) } };
}

function interrupt(p: ToolPart): ToolPart {
  return p.status === "running" ? { ...p, status: "interrupted" } : p;
}

function settleRun(vm: ConversationVM): ConversationVM {
  const messages = vm.messages.map((m) => {
    const hasRunning = m.parts.some((p) => p.type === "tool" && p.status === "running");
    if (!hasRunning && !m.pending) return m;
    const parts = m.parts.map((p) => (p.type === "tool" ? interrupt(p) : p));
    return { ...m, parts, ...(m.pending ? { pending: false } : {}) };
  });
  return { ...vm, messages, busy: false, toolStash: {} };
}

// ---- entries ----
function applyToolResult(vm: ConversationVM, entry: Wire): ConversationVM {
  const msg = entry.model?.[0];
  if (!msg || msg.role !== "toolResult") return vm;
  const texts: string[] = [];
  const images: ImagePart[] = [];
  for (const block of msg.content ?? []) {
    if (block?.type === "text") {
      if (!HARNESS_BLOCK.test(String(block.text ?? "").trim())) texts.push(block.text ?? "");
    } else if (block?.type === "image") {
      images.push({ type: "image", data: block.data ?? "", mimeType: block.mimeType ?? "image/png" });
    }
  }
  const diags: Wire[] = Array.isArray(entry.data?.diagnostics) ? entry.data.diagnostics : [];
  const interrupted = diags.some((d) => d?.code === "aborted" || d?.code === "orphaned");
  const resultText = texts.join("");
  return mapToolOrStash(vm, msg.toolCallId, msg.toolName ?? "tool", (p) => {
    const next: ToolPart = {
      ...p,
      name: msg.toolName ?? p.name,
      status: interrupted ? "interrupted" : msg.isError ? "error" : "done",
      output: resultText,
      resultText,
    };
    if (images.length) next.images = images;
    else delete next.images;
    if (msg.details !== undefined) next.details = msg.details;
    if (typeof msg.timestamp === "number") next.endedAt = msg.timestamp;
    const messages = diags.map((d) => String(d?.message ?? "")).filter(Boolean);
    if (messages.length) next.diagnostics = messages;
    else delete next.diagnostics;
    return next;
  });
}

const at = (msg: Wire): { at?: number } => (typeof msg?.timestamp === "number" ? { at: msg.timestamp } : {});

function applyEntry(vm: ConversationVM, entry: Wire): ConversationVM {
  if (!entry || typeof entry !== "object") return vm;
  const id = `e${entry.id}`;
  const msg = entry.model?.[0];
  switch (entry.kind) {
    case "pi.user": {
      if (!msg) return vm;
      return { ...vm, messages: upsertMessage(vm.messages, { id, entryId: entry.id, role: "user", parts: userParts(msg.content), ...at(msg) }) };
    }
    case "pi.assistant": {
      if (!msg) return vm;
      const stash = { ...vm.toolStash };
      const pi = pendingIndex(vm.messages);
      const existing = vm.messages.findIndex((m) => m.id === id);
      const prevParts = pi >= 0 ? vm.messages[pi].parts : existing >= 0 ? vm.messages[existing].parts : undefined;
      const out: ChatMessage = {
        id,
        entryId: entry.id,
        role: "assistant",
        parts: assistantParts(msg.content, prevParts, stash),
        ...at(msg),
        ...(msg.stopReason && msg.stopReason !== "stop" && msg.stopReason !== "toolUse" ? { stopReason: msg.stopReason } : {}),
        ...(msg.errorMessage ? { error: String(msg.errorMessage) } : {}),
      };
      let messages: ChatMessage[];
      if (pi >= 0) {
        messages = replaceAt(vm.messages, pi, out);
        if (existing >= 0 && existing !== pi) messages = messages.filter((_, i) => i !== existing);
      } else messages = upsertMessage(vm.messages, out);
      return { ...vm, messages, toolStash: stash };
    }
    case "pi.tool-result":
      return applyToolResult(vm, entry);
    case "pi.reset": {
      const handoff = msg ? userParts(msg.content) : [];
      const text = handoff.filter((p): p is TextPart => p.type === "text").map((p) => p.text).join("\n");
      const parts: Part[] = [{ type: "text", text: text ? `Context reset. Handoff:\n\n${text}` : "Context reset." }];
      return { ...vm, messages: [{ id, role: "system", parts }], toolStash: {} };
    }
    case "pi.compaction": {
      const raw = userParts(msg?.content).map((p) => (p.type === "text" ? p.text : "")).join("\n");
      const m = /<summary>\n?([\s\S]*?)\n?<\/summary>/.exec(raw);
      return { ...vm, messages: upsertMessage(vm.messages, { id, entryId: entry.id, role: "compaction", parts: [{ type: "text", text: (m ? m[1] : raw).trim() }] }) };
    }
    default:
      return vm; // pi.system and application kinds are not shown
  }
}

// ---- in-flight assistant message ----
function applyChange(parts: Part[], change: Wire): Part[] {
  switch (change.type) {
    case "text_start":
    case "thinking_start":
    case "toolcall_start": {
      const next = parts.slice();
      next.splice(change.contentIndex, 0, blockToPart(change.block));
      return next;
    }
    case "text_delta":
    case "thinking_delta": {
      const p = parts[change.contentIndex];
      const want = change.type === "text_delta" ? "text" : "thinking";
      if (!p || p.type !== want) return parts;
      return replaceAt(parts, change.contentIndex, { ...p, text: p.text + change.delta } as Part);
    }
    case "toolcall_delta": {
      const p = parts[change.contentIndex];
      if (!p || p.type !== "tool") return parts;
      return replaceAt(parts, change.contentIndex, { ...p, args: appendAt(p.args, change.path ?? [], String(change.delta ?? "")) });
    }
    case "block": {
      const next = parts.slice();
      next[change.contentIndex] = blockToPart(change.block, parts[change.contentIndex]);
      return next;
    }
    default:
      return parts;
  }
}

function appendAt(args: Record<string, unknown>, path: readonly (string | number)[], delta: string): Record<string, unknown> {
  if (path.length === 0) return args;
  const root: any = Array.isArray(args) ? args.slice() : { ...args };
  let node = root;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i] as any;
    const child = node[k];
    node[k] = Array.isArray(child) ? child.slice() : child && typeof child === "object" ? { ...child } : {};
    node = node[k];
  }
  const last = path[path.length - 1] as any;
  node[last] = typeof node[last] === "string" ? node[last] + delta : delta;
  return root;
}

function setPending(vm: ConversationVM, message: Wire): ConversationVM {
  const stash = { ...vm.toolStash };
  const pi = pendingIndex(vm.messages);
  const parts = assistantParts(message.content, pi >= 0 ? vm.messages[pi].parts : undefined, stash);
  const out: ChatMessage = { id: PENDING_ID, role: "assistant", parts, pending: true };
  return { ...vm, messages: pi >= 0 ? replaceAt(vm.messages, pi, out) : [...vm.messages, out], toolStash: stash };
}

// ---- tool execution ----
function applyOutput(current: string, output: Wire): string {
  if (!output) return current;
  if (typeof output.set === "string") return output.set;
  let next = current;
  if (output.trimStart > 0) next = next.slice(output.trimStart);
  if (typeof output.append === "string") next += output.append;
  return next;
}

// ---- events ----
function reduceEvent(vm: ConversationVM, ev: Wire): ConversationVM {
  switch (ev?.type) {
    case "run_start":
      return { ...vm, busy: true };
    case "run_end":
      return settleRun(vm);
    case "message_start":
      return ev.message?.role === "assistant" ? setPending(vm, ev.message) : vm;
    case "message_update": {
      const pi = pendingIndex(vm.messages);
      if (pi < 0) return vm;
      const msg = vm.messages[pi];
      let parts = msg.parts;
      for (const change of ev.changes ?? []) {
        if (change.type === "message") {
          const stash = { ...vm.toolStash };
          parts = assistantParts(change.message?.content, parts, stash);
        } else parts = applyChange(parts, change);
      }
      return { ...vm, messages: replaceAt(vm.messages, pi, { ...msg, parts }) };
    }
    case "message_end":
    case "entry_appended":
      return applyEntry(vm, ev.entry);
    case "tool_execution_start": {
      const args = ev.args && Object.keys(ev.args).length ? ev.args : undefined;
      return mapToolOrStash(vm, ev.toolCallId, ev.toolName, (p) => ({
        ...p,
        name: ev.toolName ?? p.name,
        ...(args ? { args } : {}),
        status: "running",
        output: "",
      }));
    }
    case "tool_execution_update":
      return mapToolOrStash(vm, ev.toolCallId, ev.toolName, (p) => ({ ...p, output: applyOutput(p.output, ev.output) }));
    case "tool_execution_end":
      return ev.entry
        ? applyToolResult(vm, ev.entry)
        : mapToolOrStash(vm, ev.toolCallId, ev.toolName, interrupt);
    case "inbox_update":
      return { ...vm, inbox: inboxOf(ev.items) };
    case "usage_changed":
      return { ...vm, usage: usageOf(ev.usage) };
    case "agent_changed":
      return { ...vm, agent: agentOf(ev.agent) };
    case "compaction_start":
      return { ...vm, compacting: vm.compacting + 1 };
    case "compaction_end":
      return { ...vm, compacting: Math.max(0, vm.compacting - 1) };
    case "task_failed":
      return {
        ...vm,
        messages: upsertMessage(vm.messages, {
          id: `task_failed:${ev.taskId}`,
          role: "system",
          tone: "error",
          parts: [{ type: "text", text: `Task failed (${ev.kind}): ${ev.message}` }],
        }),
      };
    default:
      return vm; // turn_*, submission, auto_retry_*, deferred_poll, ...
  }
}

// ---- snapshot ----
function fromSnapshot(frame: SnapshotFrame): ConversationVM {
  let vm: ConversationVM = {
    ...emptyVM(),
    busy: frame.run != null,
    inbox: inboxOf(frame.inbox),
    usage: usageOf(frame.usage),
    agent: agentOf(frame.agent),
    compacting: frame.compactions?.length ?? 0,
  };
  for (const entry of frame.entries ?? []) vm = applyEntry(vm, entry);
  if (frame.generation?.message) vm = setPending(vm, frame.generation.message);
  for (const slot of frame.tools ?? []) {
    if (slot.status === "done") {
      // Result entries are already applied; a done slot without one lost its task.
      if (slot.entry == null) vm = mapToolOrStash(vm, slot.callId, slot.name, interrupt);
    } else {
      vm = mapToolOrStash(vm, slot.callId, slot.name, (p) => ({
        ...p,
        status: "running",
        output: typeof slot.output === "string" ? slot.output : p.output,
      }));
    }
  }
  // No active run: nothing can still be executing or streaming.
  if (frame.run == null) vm = settleRun(vm);
  return { ...vm, toolStash: {} };
}

export function reduce(vm: ConversationVM, frame: Frame): ConversationVM {
  switch (frame?.type) {
    case "snapshot":
      return fromSnapshot(frame);
    case "events": {
      let next = vm;
      for (const ev of frame.events ?? []) next = reduceEvent(next, ev);
      return next;
    }
    case "error":
      return { ...vm, error: frame.error };
    default:
      return vm;
  }
}
