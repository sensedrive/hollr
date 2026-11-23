/**
 * Pure logic of the „Tickets“ view (JIRA is the source of truth): columns from the JIRA workflow plus the derived
 * „Zu grillen“ and the Sandcastle lanes, the quick filter over tickets, the build line of a ticket's GitHub family
 * and the drift texts. No DOM, no state – tested in tickets.test.ts.
 */
import { textMatcher, type Token, valueMatcher } from "./filter";
import type { DriftItem, DriftKind, FamilyMember, GuardApplied, GuardStatus, InMain, JiraBoardData, JiraStatus, JiraTicket, PullRequest, PullState, Released } from "./types";

// ---- columns

export type TicketColumn =
  | { key: string; kind: "status"; name: string; status: JiraStatus }
  | { key: "grill"; kind: "grill"; name: string }
  | { key: "lanes"; kind: "lanes"; name: string };

export const statusKey = (name: string) => `s:${name}`;
export const LANE_PREFIX = "lane@";

/** Kinds that only inform – nothing to apply (mirrors src/drift.ts INFO_KINDS). */
export const INFO_KINDS: Readonly<Record<DriftKind, boolean>> = {
  "label-on-gh": false,
  "state-behind": false,
  "done-candidate": true,
  "done-not-in-main": true,
  "no-key": true,
};

export const actionable = (t: Pick<JiraTicket, "drift">) => t.drift.filter((d) => !INFO_KINDS[d.kind]);

/**
 * JIRA statuses in workflow order; „Zu grillen“ right before Selected and the Sandcastle lanes right after it.
 * Without a (known) Selected status: „Zu grillen“ is left out and the lanes come before the first started status.
 */
export function ticketColumns(statuses: JiraStatus[], selected: string | null): TicketColumn[] {
  const cols: TicketColumn[] = statuses.map((s) => ({ key: statusKey(s.name), kind: "status", name: s.name, status: s }));
  const grill: TicketColumn = { key: "grill", kind: "grill", name: "Zu grillen" };
  const lanes: TicketColumn = { key: "lanes", kind: "lanes", name: "Sandcastle" };
  const at = selected ? statuses.findIndex((s) => s.name === selected) : -1;
  if (at >= 0) return [...cols.slice(0, at), grill, cols[at] as TicketColumn, lanes, ...cols.slice(at + 1)];
  const started = statuses.findIndex((s) => s.category !== "new");
  const cut = started < 0 ? cols.length : started;
  return [...cols.slice(0, cut), lanes, ...cols.slice(cut)];
}

/** The status column of a ticket: Selected without a story on GitHub is still „Zu grillen“. */
export function statusColumn(t: Pick<JiraTicket, "status" | "family">, selected: string | null): string {
  if (selected && t.status === selected && !t.family.story) return "grill";
  return statusKey(t.status);
}

/** The status a drop on a column asks for; null = no status change (lanes, or the ticket is there already). */
export function dropStatus(key: string, t: Pick<JiraTicket, "status">, selected: string | null): string | null {
  const to = key === "grill" ? selected : key.startsWith("s:") ? key.slice(2) : null;
  return to && to !== t.status ? to : null;
}

/** Open children of a ticket a lane drop queues (the story and the grill ticket are not built). */
export const openChildren = (t: Pick<JiraTicket, "family">) => t.family.children.filter((c) => c.state === "open").map((c) => c.n);

/**
 * The machine lane a ticket sits in: the lane of its first open child that is queued or in a live run there
 * (`laneOf`: GitHub issue → machine); its place is the smallest position of its children in that lane.
 */
export function ticketLane(
  t: Pick<JiraTicket, "family" | "category">,
  laneOf: ReadonlyMap<number, string>,
  orderOf: (server: string) => readonly number[],
): { server: string; pos: number } | null {
  if (t.category === "done") return null;
  let best: { server: string; pos: number } | null = null;
  for (const c of t.family.children) {
    if (c.state !== "open") continue;
    const server = laneOf.get(c.n);
    if (!server) continue;
    const pos = orderOf(server).indexOf(c.n);
    if (!best) best = { server, pos: pos < 0 ? Number.MAX_SAFE_INTEGER : pos };
    else if (server === best.server && pos >= 0 && pos < best.pos) best.pos = pos;
  }
  return best;
}

// ---- card facts

const TYPE_ICONS: Record<string, string> = {
  bug: "🐞",
  story: "🔖",
  task: "☑",
  aufgabe: "☑",
  epic: "⚡",
  "sub-task": "↳",
  subtask: "↳",
  "unteraufgabe": "↳",
};

export const typeIcon = (type: string) => TYPE_ICONS[type.toLowerCase()] ?? "◆";

/** „Martin Fink“ → „MF“. */
export function initials(name: string): string {
  const words = name.split(/\s+/).filter((w) => /[\p{L}\d]/u.test(w));
  const out = words.length > 1 ? `${words[0]?.[0] ?? ""}${words[words.length - 1]?.[0] ?? ""}` : (words[0] ?? "").slice(0, 2);
  return out.toUpperCase() || "?";
}

/** The filter login of a JIRA user: the first name in lower case (`@martin`). */
export const assigneeLogin = (name: string) =>
  (name.trim().split(/\s+/)[0] ?? "").toLocaleLowerCase("de").replace(/[^\p{L}\d._-]/gu, "") || "?";

/** Segment phase of a family member for the mini bar (classes of the run bars: merged, building, …). */
export function memberPhase(m: FamilyMember, phase?: string): string {
  if (m.state === "closed") return "merged";
  return phase ?? m.phase ?? "queued";
}

const SEG_ORDER = ["merged", "failed", "no-commits", "reviewing", "building", "planned", "queued"];

export interface BuildFacts {
  story: number | null;
  children: { n: number; seg: string }[];
  /** live run of a child: machine label and run percent */
  run?: { machine: string; percent: number } | null;
  /** grill progress text („Grill 2/7“) */
  grill?: string | null;
  /** the ticket's main pull request */
  pr?: PullRequest | null;
}

export interface BuildLine {
  text: string;
  segs: string[];
  /** the main PR, shown as a link after the text */
  pr: { text: string; url: string; state: PullState } | null;
}

export const PR_STATE_TEXT: Readonly<Record<PullState, string>> = { open: "offen", draft: "Entwurf", merged: "gemergt", closed: "geschlossen" };
export const CI_TEXT: Readonly<Record<NonNullable<PullRequest["checks"]>, string>> = { success: "CI ✓", failure: "CI ✗", pending: "CI …" };

/** „PR #3550 gemergt“, „PR #3551 offen · CI ✗“, „PR #3552 Entwurf“ – CI only while the PR is open. */
export function prText(p: Pick<PullRequest, "n" | "state" | "checks">): string {
  const ci = p.checks && (p.state === "open" || p.state === "draft") ? ` · ${CI_TEXT[p.checks]}` : "";
  return `PR #${p.n} ${PR_STATE_TEXT[p.state]}${ci}`;
}

/** „Story #605 · Kinder 0/3 gemergt · Lauf auf workr 43 % · Grill 2/7“ and the main PR; neither = nothing built yet. */
export function buildLine(f: BuildFacts): BuildLine {
  const merged = f.children.filter((c) => c.seg === "merged").length;
  const parts = [
    f.story ? `Story #${f.story}` : "",
    f.children.length ? `Kinder ${merged}/${f.children.length} gemergt` : "",
    f.run ? `Lauf auf ${f.run.machine} ${f.run.percent} %` : "",
    f.grill ?? "",
  ].filter(Boolean);
  const segs = f.children.map((c) => c.seg).sort((a, b) => SEG_ORDER.indexOf(a) - SEG_ORDER.indexOf(b));
  return { text: parts.join(" · "), segs, pr: f.pr ? { text: prText(f.pr), url: f.pr.url, state: f.pr.state } : null };
}

// ---- drift texts

/** One sentence per drift item, saying exactly what is off and where. */
export function driftText(d: DriftItem, derived: JiraTicket["derived"] = null, released: JiraTicket["released"] = null): string {
  switch (d.kind) {
    case "label-on-gh":
      return d.inJira
        ? `Fach-Label ${d.label} steht auf GitHub #${d.issue} – gehört nur ins Ticket`
        : `Fach-Label ${d.label} steht auf GitHub #${d.issue} – gehört ins Ticket (fehlt dort noch)`;
    case "state-behind":
      return derived === "testing"
        ? `JIRA hinkt: alle Kinder gemergt, noch ${d.actual}`
        : `JIRA hinkt: auf GitHub wird gebaut, noch ${d.actual}`;
    case "done-candidate":
      return released
        ? `Live seit ${released.version ?? `Release #${released.pr}`} – JIRA steht noch auf ${d.actual ?? "?"}`
        : `Alles in main – bereit für ${d.expected ?? "Done"}?`;
    case "done-not-in-main":
      return d.pr
        ? `In JIRA Done, aber nicht in main – PR #${d.pr.n} ist ${d.pr.state === "draft" ? "Entwurf" : "offen"}`
        : "In JIRA Done, aber nicht in main – kein gemergter PR";
    case "no-key":
      return `GitHub #${d.issue} ohne JIRA-Schlüssel`;
  }
}

// ---- live / in main

const dateDe = (iso: string) => new Date(iso).toLocaleDateString("de-DE");
const versionOf = (r: Released) => r.version ?? `#${r.pr}`;

/** The card's fact pill: live (released) > in main > partly > not in main; null without anything on GitHub. */
export function statePill(t: Pick<JiraTicket, "inMain" | "released">): { text: string; tone: "live" | InMain; title?: string } | null {
  if (t.released) return { text: `live ${versionOf(t.released)}`, tone: "live", title: `live seit ${dateDe(t.released.at)}` };
  if (!t.inMain) return null;
  return { text: { yes: "in main", partly: "teilweise in main", no: "nicht in main" }[t.inMain], tone: t.inMain };
}

/**
 * The „Stand“ line of the details: „live seit v2.0.0 (13.11.2026)“, „in main seit 12.11.2026“, „nicht in main –
 * #3550 Entwurf, CI ✗“, „teilweise in main – #3551 offen“, „nicht in main – kein gemergter PR“; null without anything.
 */
export function inMainLine(t: Pick<JiraTicket, "inMain" | "prs" | "released">): string | null {
  if (t.released) return `live seit ${versionOf(t.released)} (${dateDe(t.released.at)})`;
  if (!t.inMain) return null;
  // grill doc PRs (`docs/<KEY>-…`) are never the ticket's code
  const build = t.prs.filter((p) => !p.branch.startsWith("docs/"));
  if (t.inMain === "yes") {
    const last = build.map((p) => p.mergedAt).filter((d): d is string => !!d).sort().pop();
    return last ? `in main seit ${dateDe(last)}` : "in main";
  }
  const blocking = build.find((p) => p.state === "open" || p.state === "draft");
  const why = blocking
    ? `#${blocking.n} ${PR_STATE_TEXT[blocking.state]}${blocking.checks ? `, ${CI_TEXT[blocking.checks]}` : ""}`
    : t.inMain === "partly"
      ? "Kinder noch offen"
      : "kein gemergter PR";
  return `${t.inMain === "partly" ? "teilweise in main" : "nicht in main"} – ${why}`;
}

/** What „Angleichen“ will do, for the button's title. */
export function applyHint(t: Pick<JiraTicket, "drift">): string {
  const items = actionable(t);
  const labels = items.filter((d) => d.kind === "label-on-gh");
  const state = items.find((d) => d.kind === "state-behind");
  return [
    labels.length ? `${labels.length} Label von GitHub ins Ticket übernehmen und auf GitHub entfernen` : "",
    state ? `JIRA auf ${state.expected} vorziehen` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

// ---- GitHub side (Werkbank)

export interface IssueTicket {
  /** ticket key, null for an issue without one */
  key: string | null;
  /** the ticket's product labels (JIRA) */
  labels: string[];
  /** drift on this very issue: label-on-gh, no-key */
  drift: DriftItem[];
}

/** GitHub issue number → its ticket, the ticket's labels and the drift on that issue. */
export function issueTickets(board: Pick<JiraBoardData, "tickets" | "unlinked">): Map<number, IssueTicket> {
  const out = new Map<number, IssueTicket>();
  for (const t of board.tickets) {
    const f = t.family;
    for (const m of [...(f.grill ? [f.grill] : []), ...(f.story ? [f.story] : []), ...f.children])
      out.set(m.n, { key: t.key, labels: t.labels, drift: t.drift.filter((d) => d.kind === "label-on-gh" && d.issue === m.n) });
  }
  for (const u of board.unlinked) out.set(u.n, { key: null, labels: [], drift: u.drift });
  return out;
}

// ---- quick filter over tickets

const lc = (s: string) => s.toLocaleLowerCase("de");

const members = (t: Pick<JiraTicket, "family">) => [
  ...(t.family.grill ? [t.family.grill] : []),
  ...(t.family.story ? [t.family.story] : []),
  ...t.family.children,
];

/** A status name without its emoji: „✅ Done“ → „done“, „👀 Testing / Review“ → „testing / review“. */
export const statusName = (status: string) => lc(status.replace(/^[^\p{L}\p{N}]+/u, "").trim());

/** z:offen / z:arbeit / z:fertig address the JIRA status category, whatever the project calls its states. */
const STATUS_CATEGORY: Readonly<Record<string, JiraTicket["category"]>> = {
  offen: "new",
  neu: "new",
  arbeit: "indeterminate",
  inarbeit: "indeterminate",
  fertig: "done",
  erledigt: "done",
};

/** Phases of a Sandcastle run that mean „being worked on now“; sc:eingereiht adds the waiting ones. */
const WORKING = new Set(["planned", "building", "reviewing"]);

/** pr:<state>: gemergt/offen/entwurf/geschlossen (or the English words), pr:keiner = no pull request, pr:rot = CI failing. */
const PR_STATE: Readonly<Record<string, string>> = {
  gemergt: "merged",
  merged: "merged",
  offen: "open",
  open: "open",
  entwurf: "draft",
  draft: "draft",
  geschlossen: "closed",
  closed: "closed",
};

/**
 * The quick filter's tokens on tickets: l: JIRA labels, @ assignee (first name or any name word), s: epic (key or
 * summary) or story number, t: issue type (OR), z: status (name or offen/arbeit/fertig, OR), sc: Sandcastle working on
 * it now, pr: pull request state (pr:gemergt only build PRs, never a `docs/` PR), live: shipped in a release
 * (live:v2.0* by version), main: in main incl. released (main:teilweise partly), #n any GitHub issue of the family,
 * drift: tickets with drift to apply (drift:done: JIRA Done but not in main), text in key, summary and epic. Same
 * AND/OR rules as on GitHub issues.
 */
/** `livePhase`: a GitHub issue's phase in a live run on any machine (the view knows all machines; the server only its own). */
export function compileTickets(tokens: Token[], livePhase?: (n: number) => string | undefined): (t: JiraTicket) => boolean {
  const matcher = valueMatcher;
  const labels = tokens.filter((t) => t.kind === "label").map((t) => matcher(t, lc(t.value)));
  const nolabels = tokens.filter((t) => t.kind === "nolabel" && !t.partial).map((t) => matcher(t, lc(t.value)));
  // `@ich` has no JIRA identity behind it: it matches nobody
  const assignees = tokens.filter((t) => t.kind === "assignee").map((t) => (lc(t.value) === "ich" ? () => false : matcher(t, lc(t.value))));
  const numbers = tokens.filter((t) => t.kind === "number").map((t) => Number(t.value));
  const stories = tokens.filter((t) => t.kind === "story").map((t) => lc(t.value.replace(/^#/, "")));
  const storyText = stories.map(textMatcher);
  const drift = tokens.some((t) => t.kind === "drift" && !t.value);
  const driftDone = tokens.some((t) => t.kind === "drift" && /^(done|fertig)$/i.test(t.value));
  // live: released, live:v2.0* a version (wildcards); main: in main, main:teilweise partly – several widen (OR)
  const live = tokens
    .filter((t) => t.kind === "live")
    .map((tok) => {
      const m = tok.value ? valueMatcher(tok, lc(tok.value)) : null;
      return (t: JiraTicket) => !!t.released && (!m || m(lc(t.released.version ?? "")));
    });
  const main = tokens
    .filter((t) => t.kind === "main")
    .map((t) => (/^(teilweise|partly)$/i.test(t.value) ? "partly" : /^(nein|nicht|no)$/i.test(t.value) ? "no" : "yes"));
  const types = tokens.filter((t) => t.kind === "type").map((t) => matcher(t, lc(t.value)));
  // like -l: a half-typed exclusion would hide tickets while typing; it counts once committed
  const notypes = tokens.filter((t) => t.kind === "notype" && !t.partial).map((t) => matcher(t, lc(t.value)));
  const texts = tokens.filter((t) => t.kind === "text").map((t) => textMatcher(lc(t.value)));
  const statuses = tokens
    .filter((t) => t.kind === "status")
    .map((tok) => {
      const v = lc(tok.value);
      const cat = STATUS_CATEGORY[v];
      if (cat) return (t: JiraTicket) => t.category === cat;
      const m = matcher(tok, statusName(v));
      return (t: JiraTicket) => m(statusName(t.status));
    });
  const sandcastle = tokens
    .filter((t) => t.kind === "sandcastle")
    .map((tok) => {
      const waiting = /^(eingereiht|wartet|queue)/i.test(tok.value);
      const phaseOf = (m: { n: number; phase?: string }) => livePhase?.(m.n) ?? m.phase;
      return (t: JiraTicket) =>
        members(t).some((m) => {
          const p = phaseOf(m);
          return !!p && (WORKING.has(p) || (waiting && p === "queued"));
        });
    });
  const prs = tokens
    .filter((t) => t.kind === "pr")
    .map((tok) => {
      const v = lc(tok.value);
      if (v === "keiner" || v === "none" || v === "") return (t: JiraTicket) => !t.prs.length;
      if (v === "rot" || v === "ci-rot" || v === "failing") return (t: JiraTicket) => t.prs.some((p) => p.checks === "failure");
      const state = PR_STATE[v];
      // only build PRs count as merged: a grill doc PR (`docs/<KEY>-…`) is merged long before the work is
      if (state === "merged") return (t: JiraTicket) => t.prs.some((p) => p.state === "merged" && !p.branch.startsWith("docs/"));
      return (t: JiraTicket) => !!state && t.prs.some((p) => p.state === state);
    });
  return (t) => {
    const own = t.labels.map(lc);
    if (labels.some((m) => !own.some(m))) return false;
    if (nolabels.some((m) => own.some(m))) return false;
    if (assignees.length) {
      const name = lc(t.assignee?.name ?? "");
      const words = name ? [...name.split(/\s+/), name.replace(/\s+/g, "")] : [];
      if (!assignees.some((m) => words.some(m))) return false;
    }
    if (numbers.length && !members(t).some((m) => numbers.includes(m.n))) return false;
    if (stories.length) {
      const epic = t.epic ? [lc(t.epic.key), lc(t.epic.summary)] : [];
      const ok = stories.some((s, i) =>
        /^\d+$/.test(s)
          ? t.family.story?.n === Number(s)
          : valueMatcher({}, s)(epic[0] ?? "") || (!!epic[1] && !!storyText[i]?.(epic[1])),
      );
      if (!ok) return false;
    }
    if (drift && !actionable(t).length) return false;
    if (driftDone && !t.drift.some((d) => d.kind === "done-not-in-main")) return false;
    if (live.length && !live.some((m) => m(t))) return false;
    if (main.length && !main.some((v) => t.inMain === v)) return false;
    if (types.length && !types.some((m) => m(lc(t.type)))) return false;
    if (notypes.some((m) => m(lc(t.type)))) return false;
    // several z: / pr: widen (OR) like types; sc: tokens all ask the same question
    if (statuses.length && !statuses.some((m) => m(t))) return false;
    if (sandcastle.length && !sandcastle.some((m) => m(t))) return false;
    if (prs.length && !prs.some((m) => m(t))) return false;
    if (texts.length) {
      const hay = lc(`${t.key} ${t.summary} ${t.epic?.key ?? ""} ${t.epic?.summary ?? ""}`);
      if (texts.some((m) => !m(hay))) return false;
    }
    return true;
  };
}

/** Labels and assignees the tickets use, for suggestions and the quick row. */
export function ticketFacets(tickets: JiraTicket[]): {
  labels: Map<string, number>;
  assignees: Map<string, { name: string; count: number }>;
  epics: Map<string, string>;
  /** issue types with their ticket count (all tickets, so a type filter never hides its own chip) */
  types: Map<string, number>;
} {
  const labels = new Map<string, number>();
  const assignees = new Map<string, { name: string; count: number }>();
  const epics = new Map<string, string>();
  const types = new Map<string, number>();
  for (const t of tickets) {
    if (t.type) types.set(t.type, (types.get(t.type) ?? 0) + 1);
    if (t.category === "done") continue;
    for (const l of t.labels) labels.set(l, (labels.get(l) ?? 0) + 1);
    if (t.assignee) {
      const login = assigneeLogin(t.assignee.name);
      const a = assignees.get(login) ?? { name: t.assignee.name, count: 0 };
      a.count++;
      assignees.set(login, a);
    }
    if (t.epic) epics.set(t.epic.key, t.epic.summary);
  }
  return { labels, assignees, epics, types };
}

/** A label as JIRA takes it: no spaces. */
export const jiraLabel = (label: string) => label.trim().replace(/\s+/g, "-");

// ---- drift guard

const ago = (iso: string, now: number) => {
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  return min < 1 ? "gerade eben" : min < 60 ? `vor ${min} Min.` : `vor ${Math.floor(min / 60)} Std.`;
};

/** „vor 3 Min. · 4 angeglichen“ (· „2 Fehler“); „läuft …“ while a run is on; „noch nie geprüft“. */
export function guardSummary(g: Pick<GuardStatus, "running" | "lastRun" | "lastResult">, now = Date.now()): string {
  if (g.running) return "prüft gerade …";
  if (!g.lastRun) return "noch nie geprüft";
  const r = g.lastResult;
  return [ago(g.lastRun, now), r ? `${r.tickets} angeglichen` : "", r?.errors ? `${r.errors} Fehler` : "", r?.deferred ? `${r.deferred} beim nächsten Mal` : ""]
    .filter(Boolean)
    .join(" · ");
}

/** One applied item: „TENDR-5: Label kunde von #3540 ins Ticket“ / „TENDR-5 → In Progress“. */
export function guardItemText(a: GuardApplied): string {
  return a.kind === "label-on-gh" ? `${a.key}: Label ${a.label} von #${a.issue} ins Ticket` : `${a.key} → ${a.to}`;
}
