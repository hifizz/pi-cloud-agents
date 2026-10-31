// Terminal panel: two modes.
//
//   终端 (PTY)    REAL interactive terminal: one persistent tty shell per WebSocket
//                 (/api/bots/:id/terminal/pty; sprite.spawn {tty:true} on the backend). Full stdin,
//                 resize and signals. This is a FULL-ACCESS boundary — no per-command approval exists
//                 on a raw byte stream — so the shell only starts after the user explicitly confirms
//                 the warning. The display is a small built-in terminal emulator (see AnsiScreen):
//                 correct for normal shell I/O + SGR colors/cursor ops; heavyweight cursor-addressing
//                 apps (vim/htop/tmux) degrade — a stated limitation until @xterm/xterm is added.
//   命令控制台   NON-interactive command console (AMP13-files): each command is staged through the
//                 Sprite runner (/api/bots/:id/terminal), output streams back, commands flagged by the
//                 shared danger classifier are refused. No PTY, no stdin, no shell state.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon } from "../../components/Chat/primitives/Icon";
import { cx } from "../../lib/cx";
import type { PanelContext, PanelDefinition } from "../types";

// ---------------------------------------------------------------------------------------------------------------------
// Minimal terminal emulator (no external dep — web/node_modules has no xterm; adding one is the parent's call).
// Handles: streaming UTF-8, CR/LF/BS/TAB, SGR (16 colors + attrs), cursor movement, erase ops, insert/delete,
// scroll regions, alternate screen (ESC[?1049h/l). Not handled: wide (CJK) glyphs count as width 1, DEC
// line-drawing charset (renders as ASCII), full-screen cursor-addressing apps will look degraded.
// ---------------------------------------------------------------------------------------------------------------------

const CELL_W = 7.8; // px per column at the panel's 12px monospace font
const CELL_H = 16; // px per row (line-height)

interface Pen {
  fg: number; // -1 default, 0-15 palette
  bg: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}
const newPen = (): Pen => ({ fg: -1, bg: -1, bold: false, italic: false, underline: false, inverse: false });
const samePen = (a: Pen, b: Pen) => a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.italic === b.italic && a.underline === b.underline && a.inverse === b.inverse;
interface Cell {
  ch: string;
  pen: Pen;
}

const FG16 = ["#d4d4d8", "#f87171", "#4ade80", "#facc15", "#60a5fa", "#c084fc", "#22d3ee", "#e4e4e7", "#71717a", "#fca5a5", "#86efac", "#fde047", "#93c5fd", "#d8b4fe", "#67e8f9", "#ffffff"];
const BG16 = ["#18181b", "#7f1d1d", "#14532d", "#713f12", "#1e3a8a", "#581c87", "#164e63", "#3f3f46", "#3f3f46", "#991b1b", "#166534", "#854d0e", "#1e40af", "#6b21a8", "#155e75", "#52525b"];

/** Convert a 256-color palette index to our 16-color palette (approximate). */
const pal16 = (n: number) => (n < 16 ? n : n < 232 ? [0, 8, 1, 9, 2, 10, 3, 11, 4, 12, 5, 13, 6, 14, 7, 15][Math.round(((n - 16) % 216) / 216 * 15) % 16] : n < 244 ? 7 : 15);

class AnsiScreen {
  cols: number;
  rows: number;
  private grid: Cell[][];
  private main: Cell[][] | null = null;
  private curX = 0;
  private curY = 0;
  private savedX = 0;
  private savedY = 0;
  private scrollTop = 0;
  private scrollBot: number;
  private pen: Pen = newPen();
  private wrap = false;
  private tail = ""; // unparsed UTF-8-safe text tail (escape seq cut across frames)

  constructor(cols: number, rows: number) {
    this.cols = Math.max(2, cols | 0);
    this.rows = Math.max(2, rows | 0);
    this.scrollBot = this.rows - 1;
    this.grid = this.fresh();
  }

  private fresh(): Cell[][] {
    return Array.from({ length: this.rows }, () => Array.from({ length: this.cols }, () => ({ ch: " ", pen: newPen() })));
  }

  resize(cols: number, rows: number) {
    cols = Math.max(2, cols | 0);
    rows = Math.max(2, rows | 0);
    if (cols === this.cols && rows === this.rows) return;
    const next = Array.from({ length: rows }, (_, y) =>
      Array.from({ length: cols }, (_, x) => this.grid[y]?.[x] ?? { ch: " ", pen: newPen() }),
    );
    this.cols = cols;
    this.rows = rows;
    this.grid = next;
    this.curX = Math.min(this.curX, cols - 1);
    this.curY = Math.min(this.curY, rows - 1);
    this.scrollTop = 0;
    this.scrollBot = rows - 1;
    this.wrap = false;
  }

  /** Feed text (already UTF-8-decoded). Escape sequences may straddle calls — leftovers are buffered. */
  write(text: string) {
    const s = this.tail + text;
    this.tail = "";
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      const cp = ch.codePointAt(0)!;
      if (cp === 0x1b) {
        const used = this.escape(s, i);
        if (used === 0) {
          this.tail = s.slice(i); // incomplete sequence; wait for the rest
          break;
        }
        i += used;
      } else if (cp >= 0x20) {
        this.put(String.fromCodePoint(cp));
        i += cp > 0xffff ? 2 : 1;
      } else {
        this.control(cp);
        i += 1;
      }
    }
  }

  private control(cp: number) {
    this.wrap = false;
    if (cp === 0x0d) this.curX = 0;
    else if (cp === 0x08) this.curX = Math.max(0, this.curX - 1);
    else if (cp === 0x09) this.curX = Math.min(this.cols - 1, (Math.floor(this.curX / 8) + 1) * 8);
    else if (cp === 0x0a || cp === 0x0b || cp === 0x0c) this.lf();
    else if (cp === 0x07) {
      /* BEL: ignore */
    }
  }

  private lf() {
    if (this.curY === this.scrollBot) this.scrollUp(this.scrollTop, this.scrollBot, 1);
    else if (this.curY < this.rows - 1) this.curY++;
  }

  private scrollUp(top: number, bot: number, n: number) {
    for (let k = 0; k < n; k++) {
      const line = this.grid.splice(top, 1)[0];
      for (const c of line) {
        c.ch = " ";
        c.pen = newPen();
      }
      this.grid.splice(bot, 0, line);
    }
  }

  private scrollDown(top: number, bot: number, n: number) {
    for (let k = 0; k < n; k++) {
      const line = this.grid.splice(bot, 1)[0];
      for (const c of line) {
        c.ch = " ";
        c.pen = newPen();
      }
      this.grid.splice(top, 0, line);
    }
  }

  private put(ch: string) {
    if (this.wrap) {
      this.wrap = false;
      this.curX = 0;
      this.lf();
    }
    const cell = this.grid[this.curY][this.curX];
    cell.ch = ch;
    cell.pen = { ...this.pen };
    if (this.curX === this.cols - 1) this.wrap = true;
    else this.curX++;
  }

  /** Parse one escape sequence starting at s[i] (ESC). Returns chars consumed, or 0 when incomplete. */
  private escape(s: string, i: number): number {
    if (i + 1 >= s.length) return 0;
    const k = s[i + 1];
    if (k === "[") {
      let j = i + 2;
      while (j < s.length && !/[@-~]/.test(s[j])) j++;
      if (j >= s.length) return 0;
      this.csi(s.slice(i + 2, j), s[j]);
      return j - i + 1;
    }
    if (k === "]") {
      let j = i + 2;
      while (j < s.length && s[j] !== "\x07" && !(s[j] === "\x1b" && s[j + 1] === "\\")) j++;
      if (j >= s.length) return 0;
      return s[j] === "\x1b" ? j - i + 2 : j - i + 1; // OSC ignored (title etc.)
    }
    if (k === "(" || k === ")" || k === "#") {
      if (i + 2 >= s.length) return 0;
      return 3; // charset / alignment: ignored
    }
    // two-byte escapes
    if (k === "7") {
      this.savedX = this.curX;
      this.savedY = this.curY;
    } else if (k === "8") {
      this.curX = this.savedX;
      this.curY = this.savedY;
      this.wrap = false;
    } else if (k === "D") this.lf();
    else if (k === "M") {
      this.wrap = false;
      if (this.curY === this.scrollTop) this.scrollDown(this.scrollTop, this.scrollBot, 1);
      else if (this.curY > 0) this.curY--;
    } else if (k === "E") {
      this.curX = 0;
      this.lf();
    } else if (k === "c") {
      const r = this.rows;
      const c = this.cols;
      this.grid = this.fresh();
      this.main = null;
      this.curX = this.curY = this.savedX = this.savedY = 0;
      this.scrollTop = 0;
      this.scrollBot = Math.min(r, this.rows) - 1;
      this.rows = r;
      this.cols = c;
      this.pen = newPen();
      this.wrap = false;
    }
    return 2;
  }

  private csi(params: string, final: string) {
    const priv = params.startsWith("?");
    const parts = (priv ? params.slice(1) : params).split(";").map((p) => (p === "" ? 0 : parseInt(p, 10) || 0));
    const p = (n: number, d: number) => (parts[n] === 0 ? d : parts[n]);
    switch (final) {
      case "A":
        this.curY = Math.max(0, this.curY - p(0, 1));
        break;
      case "B":
        this.curY = Math.min(this.rows - 1, this.curY + p(0, 1));
        break;
      case "C":
        this.curX = Math.min(this.cols - 1, this.curX + p(0, 1));
        break;
      case "D":
        this.curX = Math.max(0, this.curX - p(0, 1));
        break;
      case "E":
        this.curY = Math.min(this.rows - 1, this.curY + p(0, 1));
        this.curX = 0;
        break;
      case "F":
        this.curY = Math.max(0, this.curY - p(0, 1));
        this.curX = 0;
        break;
      case "G":
      case "`":
        this.curX = Math.min(this.cols - 1, p(0, 1) - 1);
        break;
      case "d":
        this.curY = Math.min(this.rows - 1, p(0, 1) - 1);
        break;
      case "H":
      case "f":
        this.curY = Math.min(this.rows - 1, p(0, 1) - 1);
        this.curX = Math.min(this.cols - 1, p(1, 1) - 1);
        break;
      case "J": {
        const mode = parts[0] ?? 0;
        if (mode === 2 || mode === 3) {
          for (const line of this.grid) for (const c of line) (c.ch = " "), (c.pen = newPen());
        } else if (mode === 1) {
          for (let y = 0; y < this.curY; y++) for (const c of this.grid[y]) (c.ch = " "), (c.pen = newPen());
          for (let x = 0; x <= this.curX; x++) (this.grid[this.curY][x].ch = " "), (this.grid[this.curY][x].pen = newPen());
        } else {
          for (let x = this.curX; x < this.cols; x++) (this.grid[this.curY][x].ch = " "), (this.grid[this.curY][x].pen = newPen());
          for (let y = this.curY + 1; y < this.rows; y++) for (const c of this.grid[y]) (c.ch = " "), (c.pen = newPen());
        }
        break;
      }
      case "K": {
        const mode = parts[0] ?? 0;
        const [a, b] = mode === 1 ? [0, this.curX] : mode === 2 ? [0, this.cols - 1] : [this.curX, this.cols - 1];
        for (let x = a; x <= b; x++) (this.grid[this.curY][x].ch = " "), (this.grid[this.curY][x].pen = newPen());
        break;
      }
      case "L":
        this.scrollDown(this.curY, this.scrollBot, p(0, 1));
        break;
      case "M":
        this.scrollUp(this.curY, this.scrollBot, p(0, 1));
        break;
      case "P": {
        const line = this.grid[this.curY];
        for (let k = 0; k < p(0, 1); k++) {
          line.splice(this.curX, 1);
          line.push({ ch: " ", pen: newPen() });
        }
        break;
      }
      case "@": {
        const line = this.grid[this.curY];
        for (let k = 0; k < p(0, 1); k++) {
          line.splice(this.curX, 0, { ch: " ", pen: newPen() });
          line.pop();
        }
        break;
      }
      case "X":
        for (let k = 0; k < p(0, 1) && this.curX + k < this.cols; k++) (this.grid[this.curY][this.curX + k].ch = " "), (this.grid[this.curY][this.curX + k].pen = newPen());
        break;
      case "S":
        this.scrollUp(this.scrollTop, this.scrollBot, p(0, 1));
        break;
      case "T":
        if (parts.length === 1) this.scrollDown(this.scrollTop, this.scrollBot, p(0, 1));
        break;
      case "r":
        this.scrollTop = Math.min(this.rows - 1, Math.max(0, p(0, 1) - 1));
        this.scrollBot = Math.min(this.rows - 1, Math.max(this.scrollTop, p(1, this.rows) - 1));
        this.curX = this.curY = 0;
        break;
      case "s":
        this.savedX = this.curX;
        this.savedY = this.curY;
        break;
      case "u":
        this.curX = this.savedX;
        this.curY = this.savedY;
        break;
      case "m":
        this.sgr(parts);
        break;
      case "h":
      case "l":
        if (priv) this.priv(parts, final === "h");
        break;
    }
    if (!"hlr".includes(final) || !priv) this.wrap = final === "m" ? this.wrap : false;
  }

  private priv(parts: number[], set: boolean) {
    for (const n of parts) {
      if (n === 1049 || n === 1047 || n === 1048) {
        if (set) {
          if (n !== 1048) {
            this.main = this.grid;
            this.grid = this.fresh();
          }
          this.savedX = this.curX;
          this.savedY = this.curY;
          this.curX = this.curY = 0;
        } else {
          if (n !== 1048 && this.main) {
            this.grid = this.main;
            this.main = null;
          }
          this.curX = this.savedX;
          this.curY = this.savedY;
        }
      }
      // 25 cursor visibility, 7 wrap, 2004 bracketed paste, others: ignored
    }
  }

  private sgr(parts: number[]) {
    if (parts.length === 0) parts = [0];
    for (let i = 0; i < parts.length; i++) {
      const n = parts[i];
      if (n === 0) this.pen = newPen();
      else if (n === 1) this.pen.bold = true;
      else if (n === 2) this.pen.bold = true; // dim ~ bold palette side
      else if (n === 3) this.pen.italic = true;
      else if (n === 4) this.pen.underline = true;
      else if (n === 7) this.pen.inverse = true;
      else if (n === 22) this.pen.bold = false;
      else if (n === 23) this.pen.italic = false;
      else if (n === 24) this.pen.underline = false;
      else if (n === 27) this.pen.inverse = false;
      else if (n >= 30 && n <= 37) this.pen.fg = n - 30;
      else if (n === 39) this.pen.fg = -1;
      else if (n >= 40 && n <= 47) this.pen.bg = n - 40;
      else if (n === 49) this.pen.bg = -1;
      else if (n >= 90 && n <= 97) this.pen.fg = n - 90 + 8;
      else if (n >= 100 && n <= 107) this.pen.bg = n - 100 + 8;
      else if ((n === 38 || n === 48) && parts[i + 1] === 5 && typeof parts[i + 2] === "number") {
        if (n === 38) this.pen.fg = pal16(parts[i + 2]);
        else this.pen.bg = pal16(parts[i + 2]);
        i += 2;
      } else if ((n === 38 || n === 48) && parts[i + 1] === 2) {
        i += 4; // truecolor: dropped to default (palette has no RGB)
      }
    }
  }

  /** Snapshot render: one run list per row; runs share the resolved fg/bg/attrs. */
  lines(): { text: string; fg: string | undefined; bg: string | undefined; bold: boolean; italic: boolean; underline: boolean }[][] {
    return this.grid.map((line) => {
      const runs: { text: string; fg: string | undefined; bg: string | undefined; bold: boolean; italic: boolean; underline: boolean }[] = [];
      let cur: (typeof runs)[number] | null = null;
      let lastPen: Pen | null = null;
      for (const cell of line) {
        if (!lastPen || !samePen(cell.pen, lastPen)) {
          const fgIdx = cell.pen.inverse ? (cell.pen.bg >= 0 ? cell.pen.bg : 0) : cell.pen.fg >= 0 ? cell.pen.fg + (cell.pen.bold && cell.pen.fg < 8 ? 8 : 0) : -1;
          const bgIdx = cell.pen.inverse ? (cell.pen.fg >= 0 ? cell.pen.fg : -1) : cell.pen.bg >= 0 ? cell.pen.bg : -1;
          cur = {
            text: "",
            fg: fgIdx >= 0 ? FG16[fgIdx] : undefined,
            bg: bgIdx >= 0 ? BG16[bgIdx] : undefined,
            bold: cell.pen.bold && !cell.pen.inverse,
            italic: cell.pen.italic,
            underline: cell.pen.underline,
          };
          runs.push(cur);
          lastPen = cell.pen;
        }
        cur!.text += cell.ch;
      }
      return runs;
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Wire protocol (terminal/pty) — JSON frames; byte streams are base64.
// ---------------------------------------------------------------------------------------------------------------------

const b64enc = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 4096) bin += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return btoa(bin);
};
const b64dec = new TextDecoder("utf-8", { fatal: false });
const b64decBytes = (d: string) => Uint8Array.from(atob(d), (c) => c.charCodeAt(0));

type PtyFrame =
  | { type: "ready"; root: string }
  | { type: "started"; cols: number; rows: number }
  | { type: "out"; data: string }
  | { type: "exit"; state: string; exit: number | null; message?: string }
  | { type: "error"; message: string };

const KEYMAP: Record<string, string> = {
  Enter: "\r",
  Backspace: "\x7f",
  Tab: "\t",
  Escape: "\x1b",
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
  Delete: "\x1b[3~",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
};

function PtyView({ bot }: { bot: NonNullable<PanelContext["bot"]> }) {
  const [agreed, setAgreed] = useState(false);
  const [phase, setPhase] = useState<"consent" | "connecting" | "live" | "closed">("consent");
  const [nonce, setNonce] = useState(0); // bumped per (re)connect; the socket effect keys on it
  const [root, setRoot] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [dims, setDims] = useState({ cols: 80, rows: 24 });
  const screen = useMemo(() => new AnsiScreen(80, 24), []);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const ws = useRef<WebSocket | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const ime = useRef("");

  const sendInput = useCallback((text: string) => {
    const s = ws.current;
    if (!text || !s || s.readyState !== WebSocket.OPEN) return;
    s.send(JSON.stringify({ type: "in", data: b64enc(text) }));
  }, []);

  const connect = useCallback(() => {
    setPhase("connecting");
    setNote(null);
    const { protocol, host } = globalThis.location ?? { protocol: "http:", host: "127.0.0.1:8090" };
    const url = `${protocol === "https:" ? "wss:" : "ws:"}//${host}/api/bots/${encodeURIComponent(bot.id)}/terminal/pty`;
    const sock = new WebSocket(url);
    ws.current = sock;
    sock.onmessage = (ev) => {
      let f: PtyFrame;
      try {
        f = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      switch (f.type) {
        case "ready":
          setRoot(f.root);
          sock.send(JSON.stringify({ type: "start", cols: screen.cols, rows: screen.rows, env: { TERM: "xterm-256color", COLORTERM: "truecolor" } }));
          break;
        case "started":
          setPhase("live");
          break;
        case "out":
          screen.write(b64dec.decode(b64decBytes(f.data), { stream: true }));
          bump();
          break;
        case "exit":
          setPhase("closed");
          setNote(f.state === "exited" ? `shell exited (code ${f.exit ?? "?"})` : f.message ? `shell ended: ${f.message}` : `shell ${f.state}`);
          break;
        case "error":
          setNote(f.message);
          screen.write(`\x1b[31m${f.message}\x1b[0m\r\n`);
          bump();
          break;
      }
    };
    sock.onclose = () => setPhase((p) => (p === "live" ? "closed" : p === "connecting" ? "closed" : p));
    sock.onerror = () => setPhase((p) => (p === "connecting" ? "closed" : p));
    return () => {
      ws.current = null;
      sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
      try {
        sock.close();
      } catch {
        /* closed */
      }
    };
  }, [bot.id, screen]);

  // Measure the viewport -> terminal grid size; keep the server-side PTY in sync.
  const appliedDims = useRef({ cols: 80, rows: 24 });
  useEffect(() => {
    const el = boxRef.current;
    if (!el || phase !== "live") return;
    const apply = () => {
      const r = el.getBoundingClientRect();
      const cols = Math.max(20, Math.floor(r.width / CELL_W));
      const rows = Math.max(5, Math.floor(r.height / CELL_H));
      const a = appliedDims.current;
      if (a.cols === cols && a.rows === rows) return;
      appliedDims.current = { cols, rows };
      screen.resize(cols, rows);
      if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ type: "resize", cols, rows }));
      setDims({ cols, rows });
      bump();
    };
    apply();
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver === "function") {
      ro = new ResizeObserver(apply);
      ro.observe(el);
    }
    return () => ro?.disconnect();
  }, [phase, screen]);

  useEffect(() => {
    if (phase === "live") inputRef.current?.focus();
  }, [phase]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (phase !== "live") return;
    if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
      const c = e.key.toUpperCase();
      if (c >= "A" && c <= "Z") {
        e.preventDefault();
        sendInput(String.fromCharCode(c.charCodeAt(0) - 64));
        return;
      }
      if (e.key === "[" || e.key === "\\" || e.key === "]" || e.key === "^" || e.key === "_") {
        e.preventDefault();
        sendInput(String.fromCharCode(e.key.charCodeAt(0) - 64));
        return;
      }
    }
    if (e.metaKey || e.ctrlKey) return; // let browser shortcuts (copy) through
    const seq = KEYMAP[e.key];
    if (seq !== undefined) {
      e.preventDefault();
      sendInput(seq);
      return;
    }
    if (e.key.length === 1) {
      e.preventDefault();
      sendInput(e.key);
    }
  };

  const onInput = () => {
    // Paste / IME: whatever text the textarea gained is sent verbatim, then cleared.
    const el = inputRef.current;
    if (!el) return;
    const v = el.value;
    if (v && v !== ime.current) sendInput(v.slice(ime.current.length));
    ime.current = "";
    el.value = "";
  };

  const killShell = () => {
    ws.current?.readyState === WebSocket.OPEN && ws.current.send(JSON.stringify({ type: "close" }));
  };
  const interrupt = () => {
    ws.current?.readyState === WebSocket.OPEN && ws.current.send(JSON.stringify({ type: "signal", signal: "SIGINT" }));
  };

  const begin = useCallback(() => {
    setNote(null);
    setNonce((n) => n + 1);
  }, []);

  // Socket lifecycle: exactly one socket per nonce, closed on unmount or before the next connect.
  // It must NOT re-run on phase changes (connecting -> live would close the live socket).
  useEffect(() => {
    if (nonce === 0) return;
    return connect();
  }, [nonce, connect]);

  if (phase === "consent") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center text-sm">
        <Icon name="terminal" className="h-8 w-8 text-zinc-500" />
        <div className="max-w-md space-y-2 text-zinc-300">
          <p className="font-medium text-zinc-100">交互式终端 · 完全访问</p>
          <p className="text-[13px] leading-relaxed text-zinc-400">
            这会在该会话的工作目录中启动一个真实 shell：你的每次按键直接到达 Sprite，可以执行
            <span className="text-zinc-200"> 任意命令</span>
            （包括使用 Bot 在其中的登录态）。
          </p>
          <p className="text-[13px] leading-relaxed text-zinc-500">没有逐命令审批。Agent 的工具调用仍走审批；此 shell 是你本人的操作。不需要交互时，请用「命令控制台」（危险命令仍被分类器拦截）。</p>
        </div>
        <label className="flex items-center gap-2 text-[12px] text-zinc-400">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="accent-zinc-500" />
          我理解此 shell 拥有对该 Sprite 的完全访问权限
        </label>
        <button
          type="button"
          disabled={!agreed}
          onClick={begin}
          className="rounded bg-zinc-700 px-4 py-1.5 text-zinc-100 hover:bg-zinc-600 disabled:opacity-40"
        >
          启动 Shell
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col text-sm">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5 text-[12px] text-zinc-400">
        <span className="font-medium text-zinc-300">交互式终端</span>
        <span className="rounded bg-amber-900/50 px-1.5 py-0.5 text-amber-200">PTY · 完全访问 · 无逐命令审批</span>
        <span className="min-w-0 flex-1 truncate text-zinc-500" title={root ?? undefined}>
          {phase === "connecting" ? "connecting…" : phase === "closed" ? (note ?? "disconnected") : `${root ?? ""} · ${dims.cols}×${dims.rows}`}
        </span>
        {phase === "live" && (
          <>
            <button
              type="button"
              onClick={interrupt}
              className="flex items-center gap-1 rounded bg-zinc-800 px-2 py-0.5 text-zinc-300 hover:bg-zinc-700"
              aria-label="Send SIGINT"
            >
              ^C
            </button>
            <button
              type="button"
              onClick={killShell}
              className="flex items-center gap-1 rounded bg-red-900/60 px-2 py-0.5 text-red-200 hover:bg-red-800/70"
              aria-label="Kill shell"
            >
              <Icon name="stop" className="h-3.5 w-3.5" /> Kill
            </button>
          </>
        )}
        {phase === "closed" && (
          <button
            type="button"
            onClick={() => {
              screen.write("\x1b[2J\x1b[H");
              bump();
              begin();
            }}
            className="rounded bg-zinc-700 px-2 py-0.5 text-zinc-100 hover:bg-zinc-600"
          >
            重新连接
          </button>
        )}
      </div>
      <div
        ref={boxRef}
        className="relative min-h-0 flex-1 overflow-hidden bg-zinc-950 px-1 font-mono text-[12px] leading-4"
        onClick={() => inputRef.current?.focus()}
        aria-label="Terminal output"
        role="application"
      >
        <textarea
          ref={inputRef}
          onKeyDown={onKeyDown}
          onInput={onInput}
          aria-label="Terminal input"
          className="absolute inset-0 h-full w-full cursor-default resize-none bg-transparent font-mono text-[12px] text-transparent caret-transparent outline-none opacity-0"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
        />
        {phase === "connecting" && <div className="p-2 text-zinc-600">connecting…</div>}
        {screen.lines().map((runs, y) => (
          <div key={y} className="whitespace-pre">
            {runs.map((r, i) => (
              <span
                key={i}
                style={{
                  color: r.fg,
                  backgroundColor: r.bg,
                  fontWeight: r.bold ? 700 : undefined,
                  fontStyle: r.italic ? "italic" : undefined,
                  textDecoration: r.underline ? "underline" : undefined,
                }}
              >
                {r.text}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Non-interactive command console (AMP13-files) — unchanged semantics, kept as the safe default mode.
// ---------------------------------------------------------------------------------------------------------------------

type ServerFrame =
  | { type: "ready"; root: string }
  | { type: "started"; id: string; runId: string }
  | { type: "out"; id: string; data: string }
  | { type: "exit"; id: string; state: string; exit: number | null }
  | { type: "killing"; id: string }
  | { type: "denied"; id: string; reason: string }
  | { type: "error"; id?: string; message: string };

interface ConsoleLine {
  id: number;
  runId: string;
  kind: "cmd" | "out" | "exit" | "error";
  text: string;
}

function isFrame(v: unknown): v is ServerFrame {
  return typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";
}

function ConsoleView({ bot }: { bot: NonNullable<PanelContext["bot"]> }) {
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [status, setStatus] = useState<"connecting" | "ready" | "closed">("connecting");
  const [root, setRoot] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const [running, setRunning] = useState<string | null>(null); // client id of the live run
  const ws = useRef<WebSocket | null>(null);
  const nextId = useRef(0);
  const nextRun = useRef(1);
  const outRef = useRef<HTMLDivElement | null>(null);

  const push = useCallback((line: Omit<ConsoleLine, "id">) => {
    setLines((prev) => [...prev.slice(-1999), { ...line, id: ++nextId.current }]);
  }, []);

  useEffect(() => {
    setLines([]);
    setRoot(null);
    setRunning(null);
    setStatus("connecting");
    const { protocol, host } = globalThis.location ?? { protocol: "http:", host: "127.0.0.1:8090" };
    const url = `${protocol === "https:" ? "wss:" : "ws:"}//${host}/api/bots/${encodeURIComponent(bot.id)}/terminal`;
    const sock = new WebSocket(url);
    ws.current = sock;
    sock.onmessage = (ev) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (!isFrame(frame)) return;
      switch (frame.type) {
        case "ready":
          setRoot(frame.root);
          setStatus("ready");
          break;
        case "started":
          setRunning(frame.id);
          break;
        case "out":
          push({ runId: frame.id, kind: "out", text: frame.data });
          break;
        case "exit":
          setRunning((cur) => (cur === frame.id ? null : cur));
          push({
            runId: frame.id,
            kind: "exit",
            text: frame.state === "exited" ? `[exit ${frame.exit ?? "?"}]` : `[${frame.state}${frame.exit !== null ? ` ${frame.exit}` : ""}]`,
          });
          break;
        case "killing":
          push({ runId: frame.id, kind: "exit", text: "[killing…]" });
          break;
        case "denied":
          setRunning((cur) => (cur === frame.id ? null : cur));
          push({ runId: frame.id, kind: "error", text: `[denied] ${frame.reason}` });
          break;
        case "error":
          if (frame.id) setRunning((cur) => (cur === frame.id ? null : cur));
          push({ runId: frame.id ?? "", kind: "error", text: frame.message });
          break;
      }
    };
    sock.onclose = () => {
      setStatus("closed");
      setRunning(null);
    };
    sock.onerror = () => setStatus((s) => (s === "ready" ? s : "closed"));
    return () => {
      ws.current = null;
      sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
      try {
        sock.close();
      } catch {
        /* closed */
      }
    };
  }, [bot.id, push]);

  useEffect(() => {
    const el = outRef.current;
    if (el && typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight });
    else if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const run = (e: FormEvent) => {
    e.preventDefault();
    const cmd = command.trim();
    const sock = ws.current;
    if (!cmd || !sock || sock.readyState !== WebSocket.OPEN || running) return;
    const id = `r${nextRun.current++}`;
    push({ runId: id, kind: "cmd", text: `${root ?? ""}$ ${cmd}` });
    sock.send(JSON.stringify({ type: "run", id, command: cmd }));
    setCommand("");
    setRunning(id);
  };

  const kill = () => {
    const sock = ws.current;
    if (!running || !sock || sock.readyState !== WebSocket.OPEN) return;
    sock.send(JSON.stringify({ type: "kill", id: running }));
  };

  return (
    <div className="flex h-full flex-col text-sm">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5 text-[12px] text-zinc-400">
        <span className="font-medium text-zinc-300">命令控制台</span>
        <span className="rounded bg-zinc-800 px-1.5 py-0.5">非交互式 · 无 stdin · 危险命令被拦截</span>
        <span className="min-w-0 flex-1 truncate text-zinc-500" title={root ?? undefined}>
          {status === "connecting" ? "connecting…" : status === "closed" ? "disconnected" : root}
        </span>
        {running && (
          <button
            type="button"
            onClick={kill}
            className="flex items-center gap-1 rounded bg-red-900/60 px-2 py-0.5 text-red-200 hover:bg-red-800/70"
            aria-label="Kill running command"
          >
            <Icon name="stop" className="h-3.5 w-3.5" /> Kill
          </button>
        )}
      </div>
      <div ref={outRef} className="min-h-0 flex-1 overflow-y-auto bg-zinc-950 p-2 font-mono text-[12px] leading-relaxed" aria-label="Console output">
        {lines.length === 0 && <div className="text-zinc-600">Run a command; output appears here as it is produced.</div>}
        {lines.map((l) => (
          <pre
            key={l.id}
            className={cx(
              "whitespace-pre-wrap break-all",
              l.kind === "cmd" && "mt-1 text-sky-300",
              l.kind === "out" && "text-zinc-200",
              l.kind === "exit" && "text-zinc-500",
              l.kind === "error" && "text-red-400",
            )}
          >
            {l.text}
          </pre>
        ))}
      </div>
      <form onSubmit={run} className="flex items-center gap-2 border-t border-zinc-800 p-2">
        <span className="text-zinc-500">$</span>
        <input
          type="text"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder={status === "ready" ? "command…" : "waiting for connection…"}
          disabled={status !== "ready" || running !== null}
          className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-[12px] text-zinc-100 outline-none focus:border-zinc-500 disabled:opacity-50"
          aria-label="Command"
        />
        <button
          type="submit"
          disabled={status !== "ready" || running !== null || !command.trim()}
          className="rounded bg-zinc-700 px-3 py-1 text-zinc-100 hover:bg-zinc-600 disabled:opacity-40"
        >
          Run
        </button>
      </form>
    </div>
  );
}

const Component = ({ bot }: PanelContext) => {
  const [mode, setMode] = useState<"pty" | "console">("pty");
  if (!bot) return <div className="p-4 text-sm text-zinc-500">Select a session to open its terminal.</div>;
  if (bot.readOnly || bot.loopRun) return <p className="p-4 text-sm text-fg-muted">受限 Session 不提供人工 Shell，以免绕过运行权限。请在工作区新建普通 Session 使用终端。</p>;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-zinc-800 px-2 pt-1.5 text-[12px]">
        {(
          [
            ["pty", "终端 (PTY)"],
            ["console", "命令控制台"],
          ] as const
        ).map(([m, label]) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={cx("rounded-t px-2.5 py-1", mode === m ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300")}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">{mode === "pty" ? <PtyView bot={bot} /> : <ConsoleView bot={bot} />}</div>
    </div>
  );
};

export const terminalPanel: PanelDefinition = {
  id: "terminal",
  title: "Terminal",
  icon: "terminal",
  Component,
};
