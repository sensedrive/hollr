import { describe, expect, test } from "bun:test";
import { compile } from "./filter";
import { activeTokens, combine, compileTerms, exprText, isOpen, parse, serializeTerms, type Term, typedWord, unfinished } from "./query";
import { compileTickets } from "./tickets";
import type { Issue, JiraTicket } from "./types";

const ticket = (key: string, extra: Partial<JiraTicket> = {}): JiraTicket => ({
  key,
  summary: `Ticket ${key}`,
  status: "Backlog",
  category: "new",
  labels: [],
  assignee: null,
  type: "Story",
  subtask: false,
  epic: null,
  parent: null,
  priority: null,
  created: "",
  updated: "",
  url: null,
  family: { children: [] },
  derived: null,
  drift: [],
  prs: [],
  inMain: null,
  released: null,
  ...extra,
});
const person = (name: string) => ({ accountId: name, name, avatarUrl: null });

const tickets = [
  ticket("T-1", { labels: ["shop"], type: "Epic", assignee: person("Martin Fink") }),
  ticket("T-2", { labels: ["shop", "patrick-2026-10-15"], assignee: person("Justus Weber") }),
  ticket("T-3", { labels: ["kasse"], type: "Task", summary: "Kassenbon drucken" }),
  ticket("T-4", { labels: ["patrick-2026-11-12"], type: "Bug", assignee: person("Martin Fink") }),
  ticket("T-5", { labels: ["intern"], type: "Task" }),
];
const pick = (q: string, partialLast = false) => tickets.filter(compileTerms(parse(q, partialLast), compileTickets)).map((t) => t.key);

const issue = (n: number, extra: Partial<Issue> = {}): Issue => ({
  number: n,
  title: `Ticket ${n}`,
  state: "open",
  labels: [],
  assignees: [],
  author: "x",
  parent: null,
  jira: null,
  blockedBy: [],
  blockedNotes: [],
  updatedAt: "2026-11-20T10:00:00Z",
  closedAt: null,
  url: `https://github.com/o/r/issues/${n}`,
  commentsCount: 0,
  ...extra,
});
const issues = [
  issue(612, { title: "Temperaturprotokoll als PDF", labels: ["frontend", "bug"], assignees: ["mara"], parent: 600 }),
  issue(603, { title: "Lieferschein fotografieren", labels: ["mobile"], assignees: ["jonas"], parent: 600 }),
  issue(608, { title: "Notiz bei Übergabe", labels: ["frontend"], parent: 590 }),
  issue(620, { title: "Lieferanten importieren", labels: ["backend", "needs review"] }),
];
const ctx = { viewer: "mara", stories: [{ number: 600, title: "Kühlkette dokumentieren" }, { number: 590, title: "Rezepte" }] };
const run = (q: string) => issues.filter(compileTerms(parse(q), (tokens) => compile(tokens, ctx))).map((i) => i.number);

const texts = (q: string) => parse(q).map((t) => `${t.off ? "~" : ""}${exprText(t.expr)}`);

describe("parse", () => {
  test("a flat list: one term per token", () => {
    expect(texts('l:bug -l:mobile @mara s:600 #612 t:"Sub-Task" pdf')).toEqual(["l:bug", "-l:mobile", "@mara", "s:600", "#612", "t:Sub-Task", "pdf"]);
  });
  test("operators and keywords, case-insensitive, normalized", () => {
    expect(texts("(l:shop oder l:kasse) -t:Epic")).toEqual(["(l:shop ODER l:kasse)", "-t:Epic"]);
    expect(texts("@martin | @justus")).toEqual(["@martin ODER @justus"]);
    expect(texts("@martin OR @justus")).toEqual(["@martin ODER @justus"]);
    expect(texts("l:a UND l:b & l:c and l:d")).toEqual(["l:a", "l:b", "l:c", "l:d"]);
    expect(texts("NICHT (l:a) not l:b !l:c -@x")).toEqual(["-(l:a)", "-l:b", "-l:c", "-@x"]);
    expect(texts("-(l:patrick-*)")).toEqual(["-(l:patrick-*)"]);
    expect(texts("(l:a (l:b | -(l:c d)))")).toEqual(["(l:a (l:b ODER -(l:c d)))"]);
  });
  test("AND binds tighter than ODER", () => {
    const [t] = parse("l:a l:b ODER l:c");
    expect(t?.expr.k).toBe("or");
    expect(exprText(t?.expr ?? { k: "group", expr: null, open: false })).toBe("l:a l:b ODER l:c");
  });
  test("never throws: missing ) closes at the end, stray ) and dangling operators go", () => {
    const [g] = parse("(l:shop ODER l:ka");
    expect(g && isOpen(g.expr)).toBe(true);
    expect(texts("(l:shop ODER l:ka")).toEqual(["(l:shop ODER l:ka"]);
    expect(texts("l:a ) l:b")).toEqual(["l:a", "l:b"]);
    expect(texts("l:a ODER")).toEqual(["l:a"]);
    expect(texts("l:a -")).toEqual(["l:a"]);
    expect(texts("ODER | NICHT")).toEqual([]);
    expect(texts("()")).toEqual([]);
    expect(texts("(")).toEqual(["("]);
    for (const q of ["((((", "))))", "-(-(", "~", '"', 'l:"x', "|||", "-( ODER )"]) expect(() => parse(q)).not.toThrow();
  });
  test("quotes keep spaces and protect keywords", () => {
    expect(texts('l:"needs review" "oder" "-x"')).toEqual(['l:"needs review"', '"oder"', '"-x"']);
    expect(parse('"oder"')[0]?.expr).toEqual({ k: "tok", token: { kind: "text", value: "oder" } });
  });
  test("~ switches a top-level term off", () => {
    expect(parse("~-(l:patrick-*) @martin").map((t) => t.off)).toEqual([true, false]);
    expect(texts("~-(l:patrick-*) @martin")).toEqual(["~-(l:patrick-*)", "@martin"]);
  });
  test("partialLast marks the last token only when the text ends in it", () => {
    expect(activeTokens(parse("l:a l:fro", true))).toEqual([{ kind: "label", value: "a" }, { kind: "label", value: "fro", partial: true }]);
    expect(parse("(l:a)", true)[0]?.expr).toEqual({ k: "group", expr: { k: "tok", token: { kind: "label", value: "a" } }, open: false });
    expect(activeTokens(parse("l:a ", true))).toEqual([{ kind: "label", value: "a" }]);
  });
});

describe("round trip", () => {
  const cases = [
    "l:bug -l:mobile @mara s:600 #612 pdf",
    "(l:shop ODER l:kasse) -t:Epic",
    "@martin ODER @justus",
    "-(l:patrick-*)",
    "~-(l:patrick-*) @martin",
    '(l:a (l:b ODER -(l:c "needs review"))) drift:',
    "~(@a ODER @b) l:x",
    "(l:shop ODER l:ka",
    '"oder" "-x" l:"needs review"',
  ];
  for (const q of cases) test(q, () => expect(serializeTerms(parse(q))).toBe(q));
  test("normalizes once, then stays", () => {
    const once = serializeTerms(parse("NICHT ( l:a | l:b )  und @x"));
    expect(once).toBe("-(l:a ODER l:b) @x");
    expect(serializeTerms(parse(once))).toBe(once);
  });
  test("an OR next to other terms or switched off gets parentheses; only the last term may stay open", () => {
    const terms: Term[] = [...parse("@a | @b"), ...parse("l:x")];
    expect(serializeTerms(terms)).toBe("(@a ODER @b) l:x");
    expect(serializeTerms([{ ...(parse("@a | @b")[0] as Term), off: true }])).toBe("~(@a ODER @b)");
    expect(serializeTerms([...parse("(l:a"), ...parse("l:b")])).toBe("(l:a) l:b");
  });
});

describe("tickets", () => {
  test("flat list unchanged: labels AND, assignees OR, wildcards, prefix while typing", () => {
    expect(pick("l:shop")).toEqual(["T-1", "T-2"]);
    expect(pick("l:shop l:patrick*")).toEqual(["T-2"]);
    expect(pick("@martin @justus")).toEqual(["T-1", "T-2", "T-4"]);
    expect(pick("t:task t:bug")).toEqual(["T-3", "T-4", "T-5"]);
    expect(pick("l:ka", true)).toEqual(["T-3"]);
    expect(pick("-l:shop")).toEqual(["T-3", "T-4", "T-5"]);
    expect(pick("-l:sh", true)).toEqual(tickets.map((t) => t.key));
  });
  test("-(l:patrick-*) hides every patrick label", () => {
    expect(pick("-(l:patrick-*)")).toEqual(["T-1", "T-3", "T-5"]);
  });
  test("(l:shop ODER l:kasse) -t:Epic", () => {
    expect(pick("(l:shop ODER l:kasse) -t:Epic")).toEqual(["T-2", "T-3"]);
  });
  test("@martin | @justus", () => {
    expect(pick("@martin | @justus")).toEqual(["T-1", "T-2", "T-4"]);
  });
  test("nested, with wildcards inside groups", () => {
    expect(pick("(t:Task ODER (l:patrick-* -t:Bug)) -l:intern")).toEqual(["T-2", "T-3"]);
    expect(pick("NICHT (@martin | t:Task)")).toEqual(["T-2"]);
    expect(pick("(kassen* | l:shop) @martin")).toEqual(["T-1"]);
  });
  test("an off term is ignored", () => {
    expect(pick("~l:kasse")).toEqual(tickets.map((t) => t.key));
    expect(pick("~-(l:patrick-*) @martin")).toEqual(["T-1", "T-4"]);
  });
  test("while typing: an open group filters as if closed, a negated word being typed excludes nothing yet", () => {
    expect(pick("(l:shop ODER l:kas", true)).toEqual(["T-1", "T-2", "T-3"]);
    expect(pick("-(l:pat", true)).toEqual(tickets.map((t) => t.key));
    expect(pick("()")).toEqual(tickets.map((t) => t.key));
  });
});

describe("issues", () => {
  test("flat list unchanged", () => {
    expect(run("l:frontend -l:bug")).toEqual([608]);
    expect(run("#612 #620")).toEqual([612, 620]);
    expect(run("@ich")).toEqual([612]);
  });
  test("groups, OR, NOT", () => {
    expect(run("(l:mobile ODER l:backend)")).toEqual([603, 620]);
    expect(run("@mara | @jonas")).toEqual([612, 603]);
    expect(run('-(l:"needs review" | s:600)')).toEqual([608]);
    expect(run("l:front* -(l:bug)")).toEqual([608]);
  });
});

describe("filter bar helpers", () => {
  test("text starting with ODER continues the last chip", () => {
    expect(serializeTerms(combine(parse("l:x @martin"), "| @justus"))).toBe("l:x (@martin ODER @justus)");
    expect(serializeTerms(combine(parse("l:x"), "@y"))).toBe("l:x @y");
  });
  test("text after a chip missing its ) continues it", () => {
    expect(serializeTerms(combine(parse("(l:shop"), "l:kasse)"))).toBe("(l:shop l:kasse)");
  });
  test("unfinished input does not become chips", () => {
    expect(unfinished("(l:shop ODER ")).toBe(true);
    expect(unfinished("l:shop ODER ")).toBe(true);
    expect(unfinished("- ")).toBe(true);
    expect(unfinished('l:"needs ')).toBe(true);
    expect(unfinished("(l:shop) ")).toBe(false);
    expect(unfinished("l:shop ")).toBe(false);
  });
  test("the word being typed, inside groups and after operators", () => {
    expect(typedWord("(l:shop ODER l:ka")).toEqual({ start: 13, word: "l:ka" });
    expect(typedWord("-(@ma")).toEqual({ start: 2, word: "@ma" });
    expect(typedWord("@a|@j")).toEqual({ start: 3, word: "@j" });
    expect(typedWord("-l:pa")).toEqual({ start: 0, word: "-l:pa" });
    expect(typedWord("!~-t:Ep")).toEqual({ start: 2, word: "-t:Ep" });
    expect(typedWord("(l:a)")).toEqual({ start: 5, word: "" });
  });
});
