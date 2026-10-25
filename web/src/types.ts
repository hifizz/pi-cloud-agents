// ViewModel consumed by components. Nothing in here knows about the pi-durable wire protocol;
// only lib/reducer.ts translates protocol frames into these shapes.

export interface BotSummary {
  id: string;
  name: string;
  conversationId: number | string;
  model: { provider: string; modelId: string };
  instructions?: string;
  createdAt?: string | number;
  busy: boolean;
  queued: number;
  /** Present on Bots created by forking another Bot. */
  parent?: { botId: string; entryId?: number | string };
  readOnly?: boolean;
}

export interface ForkInput {
  entryId?: number | string;
  name: string;
  modelId?: string;
  readOnly: boolean;
}

/** One pending tool approval (GET /api/approvals, WS /api/approvals/stream). ids are strings on the wire. */
export interface ApprovalItem {
  taskId: string;
  conversationId?: string;
  toolName: string;
  args?: unknown;
  reason?: string;
  requestedAt?: string;
  /** Set by the sweep when the item waited > 4h. */
  reminded?: boolean;
  /** Set by the sweep when the item waited > 24h; it resolves as denied. */
  expired?: boolean;
  ageMs?: number;
}

/** One open ask_user question (WS /api/asks/stream). */
export interface AskItem {
  id: string;
  conversationId?: string;
  question: string;
  options: string[];
  askedAt?: string;
}

/** One webhook registration (GET /api/hooks). */
export interface HookItem {
  conversationId: number | string;
  token: string;
  createdAt: number;
  lastDeliveryAt: number | null;
  deliveries: number;
}

/** One background job (GET /api/jobs). */
export interface JobItem {
  id: string;
  command: string;
  label?: string;
  botConversationId?: number | string;
  logPath: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  status: string;
}

/** GET /api/bots/:id/memory. */
export interface BotMemory {
  bullets: string[];
  chars: number;
  revisions: Array<{ rev: number; at: number; count: number }>;
}

/** One saved skill (GET /api/bots/:id/skills). */
export interface SkillItem {
  name: string;
  summary: string;
}

/** One routine (GET /api/routines). Times are epoch milliseconds. */
export interface RoutineItem {
  id: string;
  bot: string | null;
  botId: string | null;
  botConversationId?: number | string;
  prompt: string;
  everyMs?: number;
  atTimes?: string[];
  enabled: boolean;
  status?: string;
  nextAt?: number;
  lastFiredAt?: number;
  fireCount?: number;
}

export interface NewRoutineInput {
  bot: string;
  prompt: string;
  everyMs: number;
}

export interface NewBotInput {
  name: string;
  modelId?: string;
  instructions?: string;
  thinkingLevel?: string;
}

export interface TextPart {
  type: "text";
  text: string;
}

export interface ThinkingPart {
  type: "thinking";
  text: string;
}

export interface ImagePart {
  type: "image";
  data: string; // base64
  mimeType: string;
}

export type ToolStatus = "running" | "done" | "error" | "interrupted";

export interface ToolPart {
  type: "tool";
  id: string; // tool call id
  name: string;
  args: Record<string, unknown>;
  status: ToolStatus;
  /** Live output while running; equals `resultText` once the result is in. */
  output: string;
  resultText?: string;
  images?: ImagePart[];
  /** Harness diagnostics (e.g. "Tool bash was aborted"). */
  diagnostics?: string[];
  /** Structured tool result details (e.g. the edit tool's diff). Shape is tool-specific. */
  details?: unknown;
  /** Server-measured execution time (approval wait excluded), from the result's details.tarsbotTiming. */
  durationMs?: number;
  /** Epoch ms when the result arrived. */
  endedAt?: number;
}

export type Part = TextPart | ThinkingPart | ToolPart | ImagePart;

export type MessageRole = "user" | "assistant" | "system" | "compaction";

export interface ChatMessage {
  id: string;
  /** Durable entry id (numeric on the wire); absent while streaming. Used as the fork point. */
  entryId?: number | string;
  role: MessageRole;
  parts: Part[];
  /** True while the message is still streaming. */
  pending?: boolean;
  /** Set on assistant messages that ended abnormally. */
  error?: string;
  stopReason?: string;
  /** Epoch ms of the underlying model message (turn timing). */
  at?: number;
  /** Visual tone for system notes. */
  tone?: "error";
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  /** USD */
  cost: number;
}

export interface AgentInfo {
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  cwd?: string;
}

export interface InboxItem {
  id: number | string;
  mode: string;
}

export interface ConversationVM {
  messages: ChatMessage[];
  busy: boolean;
  inbox: InboxItem[];
  usage: Usage;
  agent: AgentInfo;
  /** Number of live compactions. */
  compacting: number;
  /** Last stream-level error reported by the server. */
  error?: string;
  /** Internal: tool state that arrived before its assistant message. Always empty between batches in practice. */
  toolStash: Record<string, ToolPart>;
}

export type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";

/** GET /api/space. */
export interface SpaceInfo {
  sandbox: "sprites" | "e2b";
  name: string | null;
  cwd?: string;
}
