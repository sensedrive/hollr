/**
 * Pure logic of the „Tickets“ view (JIRA is the source of truth): columns from the JIRA workflow plus the derived
 * „Zu grillen“ and the Sandcastle lanes, the quick filter over tickets, the build line of a ticket's GitHub family
 * and the drift texts. No DOM, no state – tested in tickets.test.ts.
 */
import type { Token } from "./filter";
import type { DriftItem, DriftKind, FamilyMember, GuardApplied, GuardStatus, JiraBoardData, JiraStatus, JiraTicket } from "./types";

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
  pr?: number | null;
}

export interface BuildLine {
  text: string;
  segs: string[];
}

/** „Story #605 · Kinder 0/3 gemergt · Lauf auf workr 43 % · Grill 2/7 · PR #3550“; empty text = nothing built yet. */
export function buildLine(f: BuildFacts): BuildLine {
  const merged = f.children.filter((c) => c.seg === "merged").length;
  const parts = [
    f.story ? `Story #${f.story}` : "",
    f.children.length ? `Kinder ${merged}/${f.children.length} gemergt` : "",
    f.run ? `Lauf auf ${f.run.machine} ${f.run.percent} %` : "",
    f.grill ?? "",
    f.pr ? `PR #${f.pr}` : "",
  ].filter(Boolean);
  const segs = f.children.map((c) => c.seg).sort((a, b) => SEG_ORDER.indexOf(a) - SEG_ORDER.indexOf(b));
  return { text: parts.join(" · "), segs };
}

// ---- drift texts

/** One sentence per drift item, saying exactly what is off and where. */
export function driftText(d: DriftItem, derived: JiraTicket["derived"] = null): string {
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
      return `Alles gebaut und geschlossen – bereit für ${d.expected ?? "Done"}?`;
    case "no-key":
      return `GitHub #${d.issue} ohne JIRA-Schlüssel`;
  }
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

/**
 * The quick filter's tokens on tickets: l: JIRA labels, @ assignee (first name or any name word), s: epic (key or
 * summary) or story number, #n any GitHub issue of the family, drift: tickets with drift to apply, text in key,
 * summary and epic. Same AND/OR rules as on GitHub issues.
 */
export function compileTickets(tokens: Token[]): (t: JiraTicket) => boolean {
  const matcher = (t: Token, value: string) => (t.partial ? (s: string) => s.startsWith(value) : (s: string) => s === value);
  const labels = tokens.filter((t) => t.kind === "label").map((t) => matcher(t, lc(t.value)));
  const nolabels = tokens.filter((t) => t.kind === "nolabel" && !t.partial).map((t) => lc(t.value));
  // `@ich` has no JIRA identity behind it: it matches nobody
  const assignees = tokens.filter((t) => t.kind === "assignee").map((t) => (lc(t.value) === "ich" ? () => false : matcher(t, lc(t.value))));
  const numbers = tokens.filter((t) => t.kind === "number").map((t) => Number(t.value));
  const stories = tokens.filter((t) => t.kind === "story").map((t) => lc(t.value.replace(/^#/, "")));
  const drift = tokens.some((t) => t.kind === "drift");
  const texts = tokens.filter((t) => t.kind === "text").map((t) => lc(t.value));
  return (t) => {
    const own = t.labels.map(lc);
    if (labels.some((m) => !own.some(m))) return false;
    if (nolabels.some((l) => own.includes(l))) return false;
    if (assignees.length) {
      const name = lc(t.assignee?.name ?? "");
      const words = name ? [...name.split(/\s+/), name.replace(/\s+/g, "")] : [];
      if (!assignees.some((m) => words.some(m))) return false;
    }
    if (numbers.length && !members(t).some((m) => numbers.includes(m.n))) return false;
    if (stories.length) {
      const epic = t.epic ? [lc(t.epic.key), lc(t.epic.summary)] : [];
      const ok = stories.some((s) =>
        /^\d+$/.test(s)
          ? t.family.story?.n === Number(s)
          : epic[0] === s || (!!epic[1] && epic[1].includes(s)),
      );
      if (!ok) return false;
    }
    if (drift && !actionable(t).length) return false;
    if (texts.length) {
      const hay = lc(`${t.key} ${t.summary} ${t.epic?.key ?? ""} ${t.epic?.summary ?? ""}`);
      if (texts.some((x) => !hay.includes(x))) return false;
    }
    return true;
  };
}

/** Labels and assignees the tickets use, for suggestions and the quick row. */
export function ticketFacets(tickets: JiraTicket[]): {
  labels: Map<string, number>;
  assignees: Map<string, { name: string; count: number }>;
  epics: Map<string, string>;
} {
  const labels = new Map<string, number>();
  const assignees = new Map<string, { name: string; count: number }>();
  const epics = new Map<string, string>();
  for (const t of tickets) {
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
  return { labels, assignees, epics };
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
