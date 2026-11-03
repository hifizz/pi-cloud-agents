// The only module that reads the pi-durable wire protocol: the conversation view of `Conversation.watch()`
// (pi-durable 1.5), forwarded by the server's bot stream (src/api.mjs).
//   {type:"view", view}  the watch's first value: `entries` (a window over the transcript, in entry ID order) and
//                         `docs` (pi.live, pi.inbox, pi.agent, pi.usage). Sent after every (re)connect; resets the VM.
//   {type:"ops", ops}     Chord ops that turn the previous view into the next one (appends to streamed text, tool
//                         output trims/appends, entry appends, window splices, root replacements).
//   {type:"error", error} a stream-level error.
// Pure: reduce(vm, frame) -> vm. The VM is rendered from state: committed entries become messages once (in ID order),
// and pi.live is overlaid on them each frame (streaming answer, running tools, busy, run/compaction failures).
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

/** pi-durable's ConversationView, as JSON. */
export interface WireView {
  conversation?: Wire;
  entries?: Wire[];
  before?: number;
  docs?: Record<string, Wire>;
}
/** A Chord op (`@earendil-works/chord/delta` `Op`), decoded: paths inline. */
export type WireOp =
  | readonly ["r", Wire]
  | readonly ["s", readonly (string | number)[], Wire]
  | readonly ["d", readonly (string | number)[]]
  | readonly ["a", readonly (string | number)[], string]
  | readonly ["t", readonly (string | number)[], number]
  | readonly ["p", readonly (string | number)[], number, number, Wire[]]
  | readonly ["m", readonly (string | number)[], number[]];

export interface ViewFrame {
  type: "view";
  view: WireView;
}
export interface OpsFrame {
  type: "ops";
  ops: WireOp[];
}
export interface ErrorFrame {
  type: "error";
  error: string;
}
export type Frame = ViewFrame | OpsFrame | ErrorFrame;

/** What the next frame builds on, kept in `ConversationVM.wire` (opaque to components). */
interface WireState {
  view: WireView;
  /** Messages built from committed entries, before the pi.live overlay. Entries that leave the window stay. */
  committed: ChatMessage[];
  /** Highest entry ID folded into `committed`. */
  last: number;
}

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

// ---- Chord ops (immutable: containers on a changed path are copied, everything else is shared) ----
const RESERVED = new Set(["__proto__", "prototype", "constructor"]);

function copyOf(node: Wire): Wire {
  return Array.isArray(node) ? node.slice() : node && typeof node === "object" ? { ...node } : node;
}

/** Copy the root and the containers along the first `depth` segments of `path`; returns [root, the container at depth]. */
function copyPath(root: Wire, path: readonly (string | number)[], depth: number): [Wire, Wire] {
  const next = copyOf(root);
  let node = next;
  for (let i = 0; i < depth; i++) {
    const key = path[i];
    if (typeof key === "string" && RESERVED.has(key)) throw new Error(`unsafe path segment ${key}`);
    const child = copyOf(node?.[key as any]);
    if (child === null || typeof child !== "object") throw new Error(`bad op path ${JSON.stringify(path)}`);
    node[key as any] = child;
    node = child;
  }
  return [next, node];
}

export function applyOps<T>(target: T, ops: readonly WireOp[]): T {
  let root: Wire = target;
  for (const op of ops) {
    if (op[0] === "r") {
      root = op[1];
      continue;
    }
    const path = op[1];
    if (op[0] === "p" || op[0] === "m") {
      const [next, list] = copyPath(root, path, path.length);
      if (!Array.isArray(list)) throw new Error(`op target is not an array: ${JSON.stringify(path)}`);
      if (op[0] === "p") list.splice(op[2], op[3], ...op[4]);
      else {
        const prev = list.slice();
        op[2].forEach((from, i) => (list[i] = prev[from]));
      }
      root = next;
      continue;
    }
    const [next, parent] = copyPath(root, path, path.length - 1);
    const key = path[path.length - 1] as any;
    if (typeof key === "string" && RESERVED.has(key)) throw new Error(`unsafe path segment ${key}`);
    switch (op[0]) {
      case "s":
        parent[key] = op[2];
        break;
      case "d":
        if (Array.isArray(parent)) parent.splice(key, 1);
        else delete parent[key];
        break;
      case "a":
        parent[key] = String(parent[key] ?? "") + op[2];
        break;
      case "t":
        parent[key] = String(parent[key] ?? "").slice(op[2]);
        break;
    }
    root = next;
  }
  return root as T;
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

/** Convert assistant content blocks to parts (1:1 with block indexes). */
function assistantParts(content: Wire[] | undefined): Part[] {
  return (content ?? []).map((block): Part => {
    switch (block?.type) {
      case "text":
        return { type: "text", text: block.text ?? "" };
      case "thinking":
        return { type: "thinking", text: block.thinking ?? "" };
      case "toolCall":
        return newToolPart(block.id, block.name, block.arguments);
      default:
        return { type: "text", text: "" };
    }
  });
}

// ---- small immutable helpers ----
function replaceAt<T>(list: T[], i: number, value: T): T[] {
  const next = list.slice();
  next[i] = value;
  return next;
}

function upsert(messages: ChatMessage[], msg: ChatMessage): ChatMessage[] {
  const i = messages.findIndex((m) => m.id === msg.id);
  return i >= 0 ? replaceAt(messages, i, msg) : [...messages, msg];
}

/** Apply `fn` to the tool part `id` (newest match wins); unchanged when no such part exists. */
function mapTool(messages: ChatMessage[], id: string, fn: (p: ToolPart) => ToolPart): ChatMessage[] {
  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const msg = messages[mi];
    const pi = msg.parts.findIndex((p) => p.type === "tool" && p.id === id);
    if (pi < 0) continue;
    const parts = replaceAt(msg.parts, pi, fn(msg.parts[pi] as ToolPart));
    return replaceAt(messages, mi, { ...msg, parts });
  }
  return messages;
}

function interrupt(p: ToolPart): ToolPart {
  return p.status === "running" ? { ...p, status: "interrupted" } : p;
}

// ---- committed entries ----
function applyToolResult(messages: ChatMessage[], entry: Wire): ChatMessage[] {
  const msg = entry.model?.[0];
  if (!msg || msg.role !== "toolResult") return messages;
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
  const interrupted = diags.some((d) => d?.code === "aborted" || d?.code === "orphaned" || d?.code === "abandoned" || d?.code === "interrupted");
  const resultText = texts.join("");
  return mapTool(messages, msg.toolCallId, (p) => {
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
    const durationMs = msg.details?.tarsbotTiming?.durationMs;
    if (typeof durationMs === "number") next.durationMs = durationMs;
    else delete next.durationMs;
    if (typeof msg.timestamp === "number") next.endedAt = msg.timestamp;
    const lines = diags.map((d) => String(d?.message ?? "")).filter(Boolean);
    if (lines.length) next.diagnostics = lines;
    else delete next.diagnostics;
    return next;
  });
}

const at = (msg: Wire): { at?: number } => (typeof msg?.timestamp === "number" ? { at: msg.timestamp } : {});

function applyEntry(messages: ChatMessage[], entry: Wire): ChatMessage[] {
  if (!entry || typeof entry !== "object") return messages;
  const id = `e${entry.id}`;
  const msg = entry.model?.[0];
  switch (entry.kind) {
    case "pi.user":
      return msg ? upsert(messages, { id, entryId: entry.id, role: "user", parts: userParts(msg.content), ...at(msg) }) : messages;
    case "pi.assistant":
      if (!msg) return messages;
      return upsert(messages, {
        id,
        entryId: entry.id,
        role: "assistant",
        parts: assistantParts(msg.content),
        ...at(msg),
        ...(msg.stopReason && msg.stopReason !== "stop" && msg.stopReason !== "toolUse" ? { stopReason: msg.stopReason } : {}),
        ...(msg.errorMessage ? { error: String(msg.errorMessage) } : {}),
      });
    case "pi.tool-result":
      return applyToolResult(messages, entry);
    case "pi.reset": {
      const handoff = msg ? userParts(msg.content) : [];
      const text = handoff.filter((p): p is TextPart => p.type === "text").map((p) => p.text).join("\n");
      const parts: Part[] = [{ type: "text", text: text ? `Context reset. Handoff:\n\n${text}` : "Context reset." }];
      return [{ id, role: "system", parts }];
    }
    case "pi.compaction": {
      const raw = userParts(msg?.content).map((p) => (p.type === "text" ? p.text : "")).join("\n");
      const m = /<summary>\n?([\s\S]*?)\n?<\/summary>/.exec(raw);
      return upsert(messages, { id, entryId: entry.id, role: "compaction", parts: [{ type: "text", text: (m ? m[1] : raw).trim() }] });
    }
    default:
      return messages; // pi.system and application kinds are not shown
  }
}

/** Fold the window's entries newer than `last` into `committed`. A window that skipped entries (overflow) leaves a gap. */
function foldEntries(committed: ChatMessage[], last: number, entries: Wire[] | undefined): { committed: ChatMessage[]; last: number } {
  for (const entry of entries ?? []) {
    const id = Number(entry?.id);
    if (!(id > last)) continue;
    committed = applyEntry(committed, entry);
    last = id;
  }
  return { committed, last };
}

// ---- pi.live overlay ----
/** A tool part still waiting for its result entry. */
const unresolved = (p: Part): p is ToolPart => p.type === "tool" && p.status === "running" && p.resultText === undefined;

function overlayTools(messages: ChatMessage[], live: Wire, busy: boolean): ChatMessage[] {
  const slots = new Map<string, Wire>();
  for (const slot of live?.tools ?? []) slots.set(slot.callId, slot);
  let out = messages;
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    if (!msg.parts.some(unresolved)) continue;
    const parts = msg.parts.map((p) => {
      if (!unresolved(p)) return p;
      const slot = slots.get(p.id);
      if (slot === undefined) return busy ? p : interrupt(p); // no active run: nothing can still be executing
      if (slot.status === "done") return slot.entry == null ? interrupt(p) : p; // a done slot without entry lost its task
      const output = typeof slot.output === "string" ? slot.output : "";
      return p.output === output && p.status === "running" ? p : { ...p, status: "running" as const, output };
    });
    if (parts.some((p, i) => p !== msg.parts[i])) {
      if (out === messages) out = messages.slice();
      out[mi] = { ...msg, parts };
    }
  }
  return out;
}

function failureMessages(live: Wire): ChatMessage[] {
  const out: ChatMessage[] = [];
  const rf = live?.runFailure;
  if (rf && rf.reason !== "aborted" && rf.reason !== "reset") {
    out.push({
      id: `run_failed:${rf.taskId}`,
      role: "system",
      tone: "error",
      parts: [{ type: "text", text: `Run ended without an answer (${rf.reason})${rf.detail ? `: ${rf.detail}` : ""}` }],
    });
  }
  const cf = live?.compactionFailure;
  if (cf) {
    out.push({
      id: `compaction_failed:${cf.taskId}`,
      role: "system",
      tone: "error",
      parts: [{ type: "text", text: `Compaction failed (${cf.trigger ?? "?"}): ${cf.error ?? ""}` }],
    });
  }
  return out;
}

// ---- view -> VM ----
function render(prev: ConversationVM, prevWire: WireState | undefined, view: WireView): ConversationVM {
  const docs = view?.docs ?? {};
  const prevDocs = prevWire?.view.docs ?? {};
  const live = docs["pi.live"];
  const busy = live?.run !== undefined && live?.run !== null;
  const { committed, last } = foldEntries(prevWire?.committed ?? [], prevWire?.last ?? -Infinity, view?.entries);

  let messages = overlayTools(committed, live, busy);
  const failures = failureMessages(live);
  if (failures.length) messages = [...messages, ...failures];
  const streaming = busy ? live?.generation?.message : undefined;
  if (streaming) {
    const pending: ChatMessage = { id: PENDING_ID, role: "assistant", parts: assistantParts(streaming.content), pending: true };
    messages = overlayTools([...messages, pending], live, busy);
  }
  // Keep the previous array when nothing changed, so components can skip work.
  if (messages.length === prev.messages.length && messages.every((m, i) => m === prev.messages[i])) messages = prev.messages;

  const wire: WireState = { view, committed, last };
  return {
    ...prev,
    messages,
    busy,
    inbox: prevWire && docs["pi.inbox"] === prevDocs["pi.inbox"] ? prev.inbox : inboxOf(docs["pi.inbox"]?.items),
    usage: prevWire && docs["pi.usage"] === prevDocs["pi.usage"] ? prev.usage : usageOf(docs["pi.usage"]),
    agent: prevWire && docs["pi.agent"] === prevDocs["pi.agent"] ? prev.agent : agentOf(docs["pi.agent"]),
    compacting: live?.compactions?.length ?? 0,
    toolStash: {},
    wire,
  };
}

export function reduce(vm: ConversationVM, frame: Frame): ConversationVM {
  switch (frame?.type) {
    case "view":
      return render(emptyVM(), undefined, frame.view ?? {});
    case "ops": {
      const wire = vm.wire as WireState | undefined;
      if (!wire) return vm; // ops before the first view: nothing to apply them to
      return render(vm, wire, applyOps(wire.view, frame.ops ?? []));
    }
    case "error":
      return { ...vm, error: frame.error };
    default:
      return vm;
  }
}
