/**
 * Filter expressions on top of the quick filter's tokens (filter.ts):
 *   or    := and (("ODER"|"OR"|"|") and)*
 *   and   := unary+                 juxtaposition = AND; "UND"/"AND"/"&" may stand between
 *   unary := ("-"|"NICHT"|"NOT"|"!") unary | "(" or ")" | token
 * Keywords are case-insensitive; `|` splits words, `&` only counts standing alone; `-l:`/`-t:` stay tokens. All plain
 * tokens of one AND list go through the mode's compile function together, so a flat list keeps filter.ts' semantics
 * exactly (labels/text AND, same-kind assignee/story/type/number OR, the word being typed by prefix).
 * Parsing never throws: a missing ")" closes at the end (the group is marked `open`), a dangling operator and a stray
 * ")" are dropped. The top-level AND terms are the filter bar's chips; `~` before a term switches it off (kept in the
 * query, ignored by the filter).
 */
import { parseToken, type Token, type TokenKind, tokenText } from "./filter";

export type Expr =
  | { k: "tok"; token: Token }
  | { k: "not"; expr: Expr }
  | { k: "group"; expr: Expr | null; open: boolean }
  | { k: "and"; terms: Expr[] }
  | { k: "or"; terms: Expr[] };

/** A top-level AND term = one chip. */
export interface Term {
  expr: Expr;
  off: boolean;
}

type Lexeme = { t: "(" | ")" | "or" | "and" | "not" | "off" } | { t: "word"; w: string; quoted: boolean; partial?: boolean };

const KEYWORDS: Readonly<Record<string, "or" | "and" | "not">> = { oder: "or", or: "or", und: "and", and: "and", nicht: "not", not: "not" };
const QUOTED = /^(-?l:|s:|-?t:|z:|pr:|@)?"([^"]*)"?/;
const WORD = /^[^\s()|]+/;
// `-l:`/`-t:` are tokens of their own; any other leading `-` negates what follows
const MINUS_TOKEN = /^-[lt]:/i;

const lc = (s: string) => s.toLocaleLowerCase("de");

function lex(query: string): Lexeme[] {
  const out: Lexeme[] = [];
  let i = 0;
  while (i < query.length) {
    const rest = query.slice(i);
    const c = query[i] ?? "";
    if (/\s/.test(c)) i++;
    else if (c === "(" || c === ")") {
      out.push({ t: c });
      i++;
    } else if (c === "|") {
      out.push({ t: "or" });
      i++;
    } else if (/^&(?=[\s(]|$)/.test(rest)) {
      out.push({ t: "and" });
      i++;
    } else if (c === "~") {
      out.push({ t: "off" });
      i++;
    } else if (c === "!" || (c === "-" && !MINUS_TOKEN.test(rest))) {
      out.push({ t: "not" });
      i++;
    } else {
      const q = QUOTED.exec(rest);
      if (q) {
        out.push({ t: "word", w: `${q[1] ?? ""}${q[2] ?? ""}`, quoted: true });
        i += q[0].length;
        continue;
      }
      const w = WORD.exec(rest)?.[0] ?? c;
      const kw = KEYWORDS[lc(w)];
      out.push(kw ? { t: kw } : { t: "word", w, quoted: false });
      i += w.length;
    }
  }
  return out;
}

/**
 * Query text → top-level terms. `partialLast` marks the last token as still being typed when the text ends in it
 * (not after a `)` or an operator).
 */
export function parse(query: string, partialLast = false): Term[] {
  const lx = lex(query);
  const last = lx[lx.length - 1];
  if (partialLast && last?.t === "word" && !/\s$/.test(query)) last.partial = true;
  const offs = new WeakSet<Expr>();
  let i = 0;

  const unary = (depth: number): Expr | null => {
    const l = lx[i];
    if (!l) return null;
    if (l.t === "off" || l.t === "not") {
      i++;
      const next = lx[i]?.t;
      // a dangling operator (end, ")" or another operator follows) is dropped
      if (next !== "word" && next !== "(" && next !== "not" && next !== "off") return null;
      const e = unary(depth);
      if (!e) return null;
      if (l.t === "off") {
        offs.add(e);
        return e;
      }
      return { k: "not", expr: e };
    }
    if (l.t === "(") {
      i++;
      const e = or(depth + 1);
      const closed = lx[i]?.t === ")";
      if (closed) i++;
      return !e && closed ? null : { k: "group", expr: e, open: !closed };
    }
    i++;
    if (l.t !== "word") return null;
    const t = parseToken(l.w);
    return t ? { k: "tok", token: l.partial ? { ...t, partial: true } : t } : null;
  };

  const and = (depth: number): Expr | null => {
    const parts: Expr[] = [];
    for (let l = lx[i]; l && l.t !== "or" && !(l.t === ")" && depth > 0); l = lx[i]) {
      // "UND" between terms is juxtaposition; a stray ")" at the top is dropped
      if (l.t === "and" || l.t === ")") i++;
      else {
        const e = unary(depth);
        if (e) parts.push(e);
      }
    }
    return parts.length > 1 ? { k: "and", terms: parts } : (parts[0] ?? null);
  };

  const or = (depth: number): Expr | null => {
    const parts: Expr[] = [];
    for (;;) {
      const e = and(depth);
      if (e) parts.push(e);
      if (lx[i]?.t !== "or") break;
      i++;
    }
    return parts.length > 1 ? { k: "or", terms: parts } : (parts[0] ?? null);
  };

  const root = or(0);
  const items = !root ? [] : root.k === "and" ? root.terms : [root];
  return items.map((expr) => ({ expr, off: offs.has(expr) }));
}

// ---- back to text

const PREFIX: Readonly<Record<TokenKind, string>> = {
  label: "l:",
  nolabel: "-l:",
  story: "s:",
  type: "t:",
  notype: "-t:",
  status: "z:",
  sandcastle: "sc:",
  pr: "pr:",
  assignee: "@",
  number: "#",
  drift: "drift:",
  text: "",
};

/** A value that would lex differently bare gets quotes: spaces, ( ) |, or a text that reads as a keyword or operator. */
function atomText(t: Token): string {
  if (t.kind === "number" || t.kind === "drift" || t.kind === "sandcastle" || t.kind === "pr") return tokenText(t);
  const special = /[\s()|]/.test(t.value) || (t.kind === "text" && (!!KEYWORDS[lc(t.value)] || /^[-!~]|^&$/.test(t.value)));
  return special ? `${PREFIX[t.kind]}"${t.value}"` : tokenText(t);
}

/** One expression as normalized text: operators as `-`, `ODER`, juxtaposition. */
export function exprText(e: Expr): string {
  switch (e.k) {
    case "tok":
      return atomText(e.token);
    case "not":
      return `-${exprText(e.expr)}`;
    case "group":
      return `(${e.expr ? exprText(e.expr) : ""}${e.open ? "" : ")"}`;
    case "and":
      return e.terms.map(exprText).join(" ");
    case "or":
      return e.terms.map(exprText).join(" ODER ");
  }
}

/** Does the expression end in a group still missing its ")"? */
export function isOpen(e: Expr): boolean {
  switch (e.k) {
    case "tok":
      return false;
    case "not":
      return isOpen(e.expr);
    case "group":
      return e.open || (!!e.expr && isOpen(e.expr));
    default:
      return e.terms.some(isOpen);
  }
}

function closeAll(e: Expr): Expr {
  switch (e.k) {
    case "tok":
      return e;
    case "not":
      return { k: "not", expr: closeAll(e.expr) };
    case "group":
      return { k: "group", expr: e.expr && closeAll(e.expr), open: false };
    default:
      return { k: e.k, terms: e.terms.map(closeAll) };
  }
}

/**
 * The form that survives a round trip through text: next to other terms (or switched off) a bare OR gets
 * parentheses, and only the last term may miss its ")" – an open group earlier would swallow the terms after it.
 */
export function canonical(terms: Term[]): Term[] {
  return terms.map((t, i) => {
    let expr = i < terms.length - 1 ? closeAll(t.expr) : t.expr;
    if (expr.k === "or" && (terms.length > 1 || t.off)) expr = { k: "group", expr, open: false };
    return expr === t.expr ? t : { expr, off: t.off };
  });
}

/** Terms → query text; off terms carry a leading `~`. */
export const serializeTerms = (terms: Term[]) =>
  canonical(terms)
    .map((t) => `${t.off ? "~" : ""}${exprText(t.expr)}`)
    .join(" ");

// ---- the filter bar's chips and input

/**
 * Committed chips plus the text being typed → the terms in effect. Typed text that starts with ODER, or follows a
 * chip still missing its ")", continues that last chip (`@martin` + `| @justus` → one OR term).
 */
export function combine(committed: Term[], typed: string, partialLast = false): Term[] {
  if (!typed.trim()) return canonical(committed);
  const last = committed[committed.length - 1];
  if (last && (lex(typed)[0]?.t === "or" || isOpen(last.expr)))
    return canonical([...committed.slice(0, -1), ...parse(`${exprText(last.expr)} ${typed}`, partialLast)]);
  return canonical([...committed, ...parse(typed, partialLast)]);
}

/** Typed text that can't become chips yet: an open group, a trailing operator or an open quote. */
export function unfinished(typed: string): boolean {
  if (/"[^"]*$/.test(typed.replace(/"[^"]*"/g, ""))) return true;
  const lx = lex(typed);
  let depth = 0;
  for (const l of lx) depth = Math.max(0, depth + (l.t === "(" ? 1 : l.t === ")" ? -1 : 0));
  const last = lx[lx.length - 1]?.t;
  return depth > 0 || last === "or" || last === "and" || last === "not" || last === "off" || last === "(";
}

/** The word being typed at the end of the text, after a space, `(` or `|` and without leading `-`/`!`/`~` operators. */
export function typedWord(text: string): { start: number; word: string } {
  let start = /[^\s()|]*$/.exec(text)?.index ?? text.length;
  while (start < text.length && /[!~-]/.test(text[start] ?? "") && !MINUS_TOKEN.test(text.slice(start))) start++;
  return { start, word: text.slice(start) };
}

/** All tokens of an expression, at any depth. */
export function tokensOf(e: Expr): Token[] {
  switch (e.k) {
    case "tok":
      return [e.token];
    case "not":
      return tokensOf(e.expr);
    case "group":
      return e.expr ? tokensOf(e.expr) : [];
    default:
      return e.terms.flatMap(tokensOf);
  }
}

/** Plain tokens that are top-level terms switched on – what the quick row and the type chips show as active. */
export const activeTokens = (terms: Term[]) => terms.flatMap((t) => (!t.off && t.expr.k === "tok" ? [t.expr.token] : []));

// ---- evaluation

type Pred<T> = (x: T) => boolean;

/** Exclusions don't count while their word is still being typed (as `-l:` in filter.ts). */
const pendingExclusion = (t: Token) => !!t.partial && (t.kind === "nolabel" || t.kind === "notype");

/**
 * The predicate of the switched-on terms; `run` is the mode's compile function for a flat token list
 * (`compile` on issues, `compileTickets` on tickets). Parts that don't constrain anything yet (an empty group, a
 * negation of the word being typed) are left out instead of matching everything or nothing.
 */
export function compileTerms<T>(terms: Term[], run: (tokens: Token[]) => Pred<T>): Pred<T> {
  const andOf = (exprs: Expr[]): Pred<T> | null => {
    const plain = exprs.flatMap((e) => (e.k === "tok" ? [e.token] : []));
    const preds = [
      ...(plain.some((t) => !pendingExclusion(t)) ? [run(plain)] : []),
      ...exprs.flatMap((e) => {
        const p = e.k === "tok" ? null : one(e);
        return p ? [p] : [];
      }),
    ];
    if (!preds.length) return null;
    return preds.length === 1 ? (preds[0] ?? null) : (x) => preds.every((p) => p(x));
  };
  const one = (e: Expr): Pred<T> | null => {
    switch (e.k) {
      case "tok":
        return andOf([e]);
      case "and":
        return andOf(e.terms);
      case "group":
        return e.expr && one(e.expr);
      case "not": {
        if (tokensOf(e.expr).some((t) => t.partial)) return null;
        const p = one(e.expr);
        return p && ((x) => !p(x));
      }
      case "or": {
        const preds = e.terms.map(one).filter((p): p is Pred<T> => !!p);
        if (!preds.length) return null;
        return (x) => preds.some((p) => p(x));
      }
    }
  };
  return andOf(terms.filter((t) => !t.off).map((t) => t.expr)) ?? (() => true);
}
