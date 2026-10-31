// ViewModel consumed by components. Nothing in here knows about the pi-durable wire protocol;
// only lib/reducer.ts translates protocol frames into these shapes.

export type SessionStatus = "discussing" | "awaiting" | "executing" | "done";

export const SESSION_STATUS_LABEL: Record<SessionStatus, string> = {
  discussing: "讨论中",
  awaiting: "待确认",
  executing: "执行中",
  done: "已完成",
};

/** Default business status shown when a session record carries none (no migration; derived from its origin). */
export function defaultSessionStatus(bot: Pick<BotSummary, "status" | "issueLoop">): SessionStatus {
  if (bot.status) return bot.status;
  return bot.issueLoop?.sourceBotId ? "executing" : "discussing";
}

export interface BotSummary {
  id: string;
  name: string;
  conversationId: number | string;
  model: { provider: string; modelId: string };
  instructions?: string;
  createdAt?: string | number;
  busy: boolean;
  queued: number;
  /** Business status set by the human or at creation; absent on old records (see defaultSessionStatus). */
  status?: SessionStatus;
  /** Workspace the Bot belongs to directly (set on issue-loop sessions, which are not forks). */
  workspaceId?: string;
  /** Present on Bots created by forking another Bot. */
  parent?: { botId: string; entryId?: number | string };
  readOnly?: boolean;
  /** SPIKE-add-session: a session added by hand from the workspace menu runs in its own detached worktree. */
  worktree?: {
    branch?: string;
    baseBranch: string;
    pinnedSha: string;
    dir: string;
  };
  /** Issue-loop spike metadata: this session's own git state + the source discussion backlink. */
  issueLoop?: {
    issue: number;
    baseBranch: string;
    /** Baseline commit pinned when the discussion was opened. */
    pinnedSha: string;
    /** The worktree directory the session runs in. */
    dir: string;
    /** Execution sessions only: their own branch (discussions are detached, no branch). */
    branch?: string;
    /** Execution sessions only: the discussion Bot this was published from (UI backlink only, not history). */
    sourceBotId?: string;
  };
  /** SPIKE-review-loop: a one-click PR review session (detached at the pinned PR head SHA). */
  review?: {
    pr: number;
    title?: string;
    baseBranch?: string;
    headSha: string;
    dir: string;
  };
  /** SPIKE-review-loop: human-reported result of an execution session. */
  executionResult?: {
    summary: string;
    /** Human-entered test notes; never an automated pass/fail. null = 未记录. */
    testsReportedByHuman: string | null;
    pull: { number: number; title: string; url: string; state?: string; headSha?: string | null } | null;
    issue: number;
    sourceBotId: string;
    reportedAt: string;
  };
  /** Issue14: this Session was created by a Loop run (UI backlink "来自 Loop"). Carries the run's own worktree so
   *  Files/Git/Header never fall back to the workspace cwd, plus the capability level future integrations must keep. */
  loopRun?: {
    loopId: string;
    runId: string;
    version: number;
    /** The run's worktree directory (empty-dir runs: a stable non-repo dir). */
    dir?: string;
    /** Pinned baseline commit the worktree was taken from. */
    pinnedSha?: string;
    /** Own branch (code=readwrite runs), else detached HEAD. */
    branch?: string | null;
    /** Capability level this session was created under (Phase 2 integrations read the restriction here). */
    capabilities?: { code: "none" | "read" | "readwrite"; web: boolean };
  };
}

export interface ForkInput {
  entryId?: number | string;
  name: string;
  modelId?: string;
  /** M1: forks are read-only copies; the writable option is gone. */
  readOnly: true;
}

/** One pending tool approval (GET /api/approvals, WS /api/approvals/stream). ids are strings on the wire. */
export interface ApprovalItem {
  taskId: string;
  conversationId?: string;
  toolName: string;
  args?: unknown;
  reason?: string;
  requestedAt?: string;
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

