// Pure presentation layer: ChatMessage[] -> flat feed rows.
// A "turn" is one user message plus the assistant messages that follow it. Once a turn has settled,
// everything between its first and last assistant text (thinking, tool calls) folds behind a single
// "Worked for …" row, like the reference work-session feed.
import type { ChatMessage, Part, ToolPart } from "../types";
import { diffStats, isFileMutation, toolDiff, type DiffLine } from "./diff";
import { fmtDuration } from "./format";

export interface ChangedFile {
  path: string;
  add: number;
  del: number;
  lines: DiffLine[];
}

export type FeedRow =
  | { type: "message"; key: string; message: ChatMessage }
  | { type: "part"; key: string; message: ChatMessage; part: Part; streaming: boolean; fork: boolean }
  | { type: "notice"; key: string; message: ChatMessage }
  | { type: "fold"; key: string; turnKey: string; label: string; steps: number; open: boolean; rows: FeedRow[] }
  | { type: "files"; key: string; files: ChangedFile[] };

type Block = { kind: "turn"; key: string; user?: ChatMessage; assistants: ChatMessage[] } | { kind: "solo"; message: ChatMessage };

const isBlankText = (p: Part) => p.type === "text" && !p.text;

function toBlocks(messages: ChatMessage[]): Block[] {
  const blocks: Block[] = [];
  let cur: Extract<Block, { kind: "turn" }> | undefined;
  for (const m of messages) {
    if (m.role === "user") {
      cur = { kind: "turn", key: m.id, user: m, assistants: [] };
      blocks.push(cur);
    } else if (m.role === "assistant") {
      if (!cur) {
        cur = { kind: "turn", key: `t${blocks.length}`, assistants: [] };
        blocks.push(cur);
      }
      cur.assistants.push(m);
    } else {
      blocks.push({ kind: "solo", message: m });
      cur = undefined;
    }
  }
  return blocks;
}

function changedFiles(tools: ToolPart[]): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  for (const t of tools) {
    if (!isFileMutation(t) || t.status !== "done") continue;
    const d = toolDiff(t);
    if (!d || d.lines.length === 0) continue;
    const { add, del } = diffStats(d.lines);
    const prev = byPath.get(d.path);
    if (prev) {
      prev.add += add;
      prev.del += del;
      prev.lines = [...prev.lines, { kind: "gap", text: "…" }, ...d.lines];
    } else byPath.set(d.path, { path: d.path, add, del, lines: d.lines });
  }
  return [...byPath.values()];
}

function elapsedMs(turn: { user?: ChatMessage; assistants: ChatMessage[] }, tools: ToolPart[]): number | undefined {
  const start = turn.user?.at ?? turn.assistants[0]?.at;
  const ends = [...turn.assistants.map((a) => a.at), ...tools.map((t) => t.endedAt)].filter((n): n is number => typeof n === "number");
  if (start === undefined || ends.length === 0) return undefined;
  const ms = Math.max(...ends) - start;
  return ms > 0 ? ms : undefined;
}

export function deriveFeed(messages: ChatMessage[], opts: { busy: boolean; expanded: ReadonlySet<string> }): FeedRow[] {
  const blocks = toBlocks(messages);
  let lastTurn = -1;
  blocks.forEach((b, i) => {
    if (b.kind === "turn") lastTurn = i;
  });

  const rows: FeedRow[] = [];
  blocks.forEach((block, bi) => {
    if (block.kind === "solo") {
      rows.push({ type: "message", key: block.message.id, message: block.message });
      return;
    }
    if (block.user) rows.push({ type: "message", key: block.user.id, message: block.user });

    const entries = block.assistants.flatMap((a) => a.parts.filter((p) => !isBlankText(p)).map((part) => ({ message: a, part })));
    const tools = entries.flatMap((e) => (e.part.type === "tool" ? [e.part] : []));
    const live = (opts.busy && bi === lastTurn) || block.assistants.some((a) => a.pending);

    // Fold: settled turn with a final answer, hiding everything between first and last text.
    const hidden = new Set<number>();
    const textIdx = entries.flatMap((e, i) => (e.part.type === "text" ? [i] : []));
    const endsWithAnswer = entries.length > 0 && entries[entries.length - 1].part.type === "text";
    if (!live && endsWithAnswer && !tools.some((t) => t.status === "running")) {
      const keep = new Set([textIdx[0], textIdx[textIdx.length - 1]]);
      entries.forEach((e, i) => {
        if (!keep.has(i) && e.part.type !== "image") hidden.add(i);
      });
      if (![...hidden].some((i) => entries[i].part.type === "tool")) hidden.clear();
    }
    const hiddenSteps = [...hidden].filter((i) => entries[i].part.type === "tool").length;
    const open = opts.expanded.has(block.key);

    let n = 0;
    let fold: Extract<FeedRow, { type: "fold" }> | undefined;
    for (const a of block.assistants) {
      // Fork targets the message's last visible row, and its last row overall once the fold is open.
      let lastVisible: FeedRow | undefined;
      let lastAny: FeedRow | undefined;
      for (const part of a.parts) {
        if (isBlankText(part)) continue;
        const idx = n++;
        const row: FeedRow = {
          type: "part",
          key: part.type === "tool" ? part.id : `${block.key}:${idx}`,
          message: a,
          part,
          streaming: !!a.pending && part === a.parts[a.parts.length - 1],
          fork: false,
        };
        if (hidden.has(idx)) {
          if (!fold) {
            const ms = elapsedMs(block, tools);
            fold = { type: "fold", key: `fold:${block.key}`, turnKey: block.key, label: ms ? `Worked for ${fmtDuration(ms)}` : "Worked", steps: hiddenSteps, open, rows: [] };
            rows.push(fold);
          }
          fold.rows.push(row);
        } else {
          rows.push(row);
          lastVisible = row;
        }
        lastAny = row;
      }
      if (a.entryId !== undefined && !a.pending) {
        for (const r of [lastVisible, lastAny]) if (r?.type === "part") r.fork = true;
      }
      if (a.error || a.stopReason === "aborted") rows.push({ type: "notice", key: `${block.key}:notice:${a.id}`, message: a });
    }

    if (!live) {
      const files = changedFiles(tools);
      if (files.length > 0) rows.push({ type: "files", key: `files:${block.key}`, files });
    }
  });
  return rows;
}

/** Thinking / tool / fold rows read as one compact activity list. */
const isActivity = (r: FeedRow) => r.type === "fold" || (r.type === "part" && r.part.type !== "text" && r.part.type !== "image");

/** Spacing above a row, decided by its neighbour: tight inside an activity run, wide before a user turn. */
export function gapBefore(prev: FeedRow | undefined, row: FeedRow): string {
  if (!prev) return "";
  if (row.type === "message" && row.message.role === "user") return "mt-8";
  if (isActivity(prev) && isActivity(row)) return "mt-0.5";
  return "mt-4";
}
