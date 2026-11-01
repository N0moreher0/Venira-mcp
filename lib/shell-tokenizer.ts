import { PLATFORM } from "./workspace.js";

export type Token = { type: "word" | "op" | "redirect"; value: string };

const REDIRECT_OPS = new Set([">", ">>", ">|", "<", "<<", "&>", "&>>"]);

/**
 * Split a command line into words, operators, and redirects.
 * The parser is intentionally conservative: unsupported syntax remains
 * visible to policy evaluation rather than being silently normalized.
 */
export function tokenize(raw: string): { tokens: Token[]; has_substitution: boolean } {
  const tokens: Token[] = [];
  let word = "";
  let hasWord = false;
  let quote: "'" | '"' | null = null;
  let hasSubstitution = false;

  const flush = (): void => {
    if (!hasWord) return;
    tokens.push({ type: "word", value: word });
    word = "";
    hasWord = false;
  };
  const pushOp = (op: string): void => {
    flush();
    tokens.push({ type: REDIRECT_OPS.has(op) || op.startsWith(">&") ? "redirect" : "op", value: op });
  };

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];

    if (quote === "'") {
      if (ch === "'") quote = null;
      else {
        word += ch;
        hasWord = true;
      }
      continue;
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (ch === "\\" && i + 1 < raw.length) {
        word += raw[i + 1];
        i += 1;
        hasWord = true;
        continue;
      }
      if (ch === "`" || (ch === "$" && raw[i + 1] === "(")) hasSubstitution = true;
      word += ch;
      hasWord = true;
      continue;
    }

    if (ch === "\\") {
      if (PLATFORM !== "win32" && i + 1 < raw.length) {
        word += raw[i + 1];
        i += 1;
        hasWord = true;
      } else {
        word += ch;
        hasWord = true;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasWord = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      flush();
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      flush();
      pushOp(";");
      if (ch === "\r" && raw[i + 1] === "\n") i += 1;
      continue;
    }
    if (ch === "`") {
      hasSubstitution = true;
      word += ch;
      hasWord = true;
      continue;
    }
    if (ch === "$" && raw[i + 1] === "(") {
      hasSubstitution = true;
      word += ch;
      hasWord = true;
      continue;
    }

    if (";&|<>".includes(ch)) {
      if (ch === ">" && raw[i + 1] === "&" && /^[0-9]*$/.test(word)) {
        let j = i + 2;
        let fd = "";
        while (j < raw.length && /[0-9-]/.test(raw[j])) {
          fd += raw[j];
          j += 1;
        }
        word = "";
        hasWord = false;
        tokens.push({ type: "redirect", value: ">&" + fd });
        i = j - 1;
        continue;
      }
      if ((ch === ">" || ch === "<") && /^[0-9]+$/.test(word)) {
        word = "";
        hasWord = false;
      }

      const three = raw.slice(i, i + 3);
      const two = raw.slice(i, i + 2);
      let op = ch;
      if (three === "&>>") op = three;
      else if ([">>", "&&", "||", "&>", ">|", "<<", "2>", "1>", "0<"].includes(two)) op = two;
      pushOp(op);
      i += op.length - 1;
      continue;
    }

    word += ch;
    hasWord = true;
  }
  flush();

  return { tokens, has_substitution: hasSubstitution };
}
