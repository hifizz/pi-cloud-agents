// Naive single-line TS/JS tokenizer for the diff panel. Returns tokens (rendered by React as spans),
// never HTML. Good enough for read-only diffs; it does not track multi-line state.
export type TokenKind = "kw" | "str" | "num" | "type" | "fn" | "pun" | "cm";
export interface Token {
  text: string;
  kind?: TokenKind;
}

const MAX_LINE = 2000;
const JS_LANGS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"]);
const KEYWORDS = new Set(
  "import export from as default const let var function return if else for while do switch case break continue new class extends implements interface type enum async await try catch finally throw typeof instanceof in of void delete yield static public private protected readonly this super null undefined true false".split(" "),
);

// Order matters: comment, string, number, identifier, punctuation, other.
const RE = /(\/\/.*$|\/\*.*?\*\/)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|([{}()[\];,.<>:=+\-*/%!&|?^~]+)|(\s+|.)/gy;

export function isHighlightable(lang?: string): boolean {
  return !!lang && JS_LANGS.has(lang.toLowerCase());
}

export function tokenize(line: string, lang?: string): Token[] {
  if (line.length === 0) return [];
  if (line.length > MAX_LINE || (lang !== undefined && !isHighlightable(lang))) return [{ text: line }];
  const out: Token[] = [];
  const push = (text: string, kind?: TokenKind) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push(kind ? { text, kind } : { text });
  };
  RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (RE.lastIndex < line.length && (m = RE.exec(line))) {
    const [text, cm, str, num, id, pun] = m;
    if (cm) push(text, "cm");
    else if (str) push(text, "str");
    else if (num) push(text, "num");
    else if (id) {
      if (KEYWORDS.has(id)) push(text, "kw");
      else if (/^[A-Z]/.test(id)) push(text, "type");
      else if (line[RE.lastIndex] === "(") push(text, "fn");
      else push(text);
    } else if (pun) push(text, "pun");
    else push(text);
  }
  return out;
}
