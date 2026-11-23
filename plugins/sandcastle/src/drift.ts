/**
 * JIRA is the source of truth, GitHub the derived „Werkbank“ (pure, no I/O):
 * - JIRA owns content, product labels, assignee and state; GitHub owns only the workflow labels and build
 *   progress. GitHub issues reference their ticket and carry no product labels: one found on an open family
 *   issue is drift (moved to JIRA if JIRA lacks it, then removed from GitHub).
 * - The JIRA state follows GitHub progress forward only: work picked or a story grilled → at least
 *   „in progress“, everything built and closed → at least „testing“. Done is never derived.
 * A family is what GitHub holds for one ticket: the grill ticket, the story, the story's children – linked by
 * the `## JIRA` section of their bodies (children may inherit the key from their story's `## Parent`).
 */
import type { JiraStates, JiraStatus, JiraTicket } from "./jira";
import type { Project } from "./types";

export interface GhIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  labels: string[];
  parent: number | null;
  jira: string | null;
}

export interface FamilyMember {
  n: number;
  title: string;
  state: "open" | "closed";
  labels: string[];
  /** phase in a live Sandcastle run */
  phase?: string;
}

export interface Family {
  grill?: FamilyMember;
  story?: FamilyMember;
  children: FamilyMember[];
}

export type DriftKind = "label-on-gh" | "state-behind" | "done-candidate" | "no-key";

/** Kinds that only inform – nothing to apply. */
export const INFO_KINDS: Readonly<Record<DriftKind, boolean>> = {
  "label-on-gh": false,
  "state-behind": false,
  "done-candidate": true,
  "no-key": true,
};

export interface DriftItem {
  kind: DriftKind;
  issue?: number;
  label?: string;
  /** label-on-gh: the ticket already has the label in JIRA */
  inJira?: boolean;
  expected?: string;
  actual?: string;
}

export type DerivedState = "inProgress" | "testing";

export interface DriftConfig {
  labels: Project["labels"];
  states: JiraStates;
  /** in workflow order */
  statuses: JiraStatus[];
}

/** Issue number → phase of the issue in a live run on this machine. */
export type LivePhases = ReadonlyMap<number, string>;

export interface Families {
  byKey: Map<string, Family>;
  /** open family roots (stories, grill tickets, single issues) without any JIRA key */
  unlinked: FamilyMember[];
}

const member = (i: GhIssue, live?: LivePhases): FamilyMember => {
  const phase = live?.get(i.number);
  return { n: i.number, title: i.title, state: i.state, labels: i.labels, ...(phase ? { phase } : {}) };
};

/** Of two candidates for one role: the open one, else the newer. */
const better = (a: FamilyMember | undefined, b: FamilyMember) =>
  !a || (a.state !== b.state ? b.state === "open" : b.n > a.n) ? b : a;

export function families(issues: GhIssue[], labels: Project["labels"], live?: LivePhases): Families {
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  const isStory = (i: GhIssue) => i.labels.includes(labels.story);
  const byKey = new Map<string, Family>();
  const unlinked = new Map<number, FamilyMember>();
  for (const i of issues) {
    const parent = i.parent === null ? undefined : byNumber.get(i.parent);
    const storyParent = parent && isStory(parent) ? parent : undefined;
    const key = i.jira ?? storyParent?.jira ?? null;
    if (!key) {
      // reported once per root: a keyless story stands for its children
      const root = isStory(i) ? i : (storyParent ?? i);
      if (i.state === "open" && !unlinked.has(root.number)) unlinked.set(root.number, member(root, live));
      continue;
    }
    let f = byKey.get(key);
    if (!f) {
      f = { children: [] };
      byKey.set(key, f);
    }
    if (isStory(i)) f.story = better(f.story, member(i, live));
    else if (labels.grill && i.labels.includes(labels.grill)) f.grill = better(f.grill, member(i, live));
    else f.children.push(member(i, live));
  }
  for (const f of byKey.values()) f.children.sort((a, b) => a.n - b.n);
  return { byKey, unlinked: [...unlinked.values()].sort((a, b) => b.n - a.n) };
}

/** Live phases in which an issue counts as picked by a run. */
const PICKED: Record<string, true> = {
  planned: true,
  building: true,
  reviewing: true,
  merged: true,
  failed: true,
  "no-commits": true,
};

/** The least JIRA state GitHub's progress implies, or null when it implies nothing. */
export function deriveState(f: Family, labels: Project["labels"]): DerivedState | null {
  const built = [...(f.story ? [f.story] : []), ...f.children];
  if (built.length && built.every((m) => m.state === "closed")) return "testing";
  const working = f.children.some(
    (c) => c.state === "open" && (c.labels.includes(labels.queue) || (!!c.phase && Object.hasOwn(PICKED, c.phase))),
  );
  const grilled = !!f.story && (!f.grill || f.grill.state === "closed");
  return working || grilled ? "inProgress" : null;
}

const members = (f: Family) => [...(f.grill ? [f.grill] : []), ...(f.story ? [f.story] : []), ...f.children];

/** Labels every project keeps on GitHub: GitHub's defaults and the lul-workr process labels. */
export const DEFAULT_WORKFLOW_LABELS = [
  "bug",
  "documentation",
  "duplicate",
  "enhancement",
  "good first issue",
  "help wanted",
  "invalid",
  "question",
  "wontfix",
  "ready-for-human",
  "needs-info",
  "needs-triage",
  "to-diagnose",
  "teilweise",
  "dependencies",
  "javascript",
];
const WORKFLOW_PREFIXES = ["wayfinder:"];

/** Whether a GitHub label is a workflow label (GitHub owns it, never drift); names compare case-insensitively. */
export function workflowMatcher(labels: Project["labels"]): (label: string) => boolean {
  const names = new Set(
    // older hollr servers (≤ 0.52.0) don't send `workflow` yet
    [labels.queue, labels.story, labels.grill, labels.ready, labels.ciFailed, labels.nogo, ...(labels.workflow ?? [])]
      .filter((l): l is string => !!l)
      .concat(DEFAULT_WORKFLOW_LABELS)
      .map((l) => l.toLowerCase()),
  );
  return (label) => {
    const l = label.toLowerCase();
    return names.has(l) || WORKFLOW_PREFIXES.some((p) => l.startsWith(p));
  };
}

/** A GitHub label as JIRA label: JIRA labels have no spaces. */
export const jiraLabel = (label: string) => label.trim().replace(/\s+/g, "-");

export interface TicketDrift {
  derived: DerivedState | null;
  drift: DriftItem[];
}

export function ticketDrift(t: JiraTicket, f: Family | undefined, cfg: DriftConfig): TicketDrift {
  if (!f) return { derived: null, drift: [] };
  const drift: DriftItem[] = [];
  const isWorkflow = workflowMatcher(cfg.labels);
  const inJira = new Set(t.labels.map((l) => l.toLowerCase()));
  for (const m of members(f)) {
    if (m.state !== "open") continue;
    for (const label of m.labels)
      if (!isWorkflow(label))
        drift.push({ kind: "label-on-gh", issue: m.n, label, inJira: inJira.has(jiraLabel(label).toLowerCase()) });
  }
  const derived = deriveState(f, cfg.labels);
  const at = cfg.statuses.findIndex((s) => s.name === t.status);
  const target = derived ? cfg.states[derived] : null;
  const goal = target ? cfg.statuses.findIndex((s) => s.name === target) : -1;
  // forward only: a done or unknown status is never pulled back, nor is anything past the goal
  if (target && t.category !== "done" && at >= 0 && goal >= 0 && at < goal)
    drift.push({ kind: "state-behind", expected: target, actual: t.status });
  const all = members(f);
  if (all.length && all.every((m) => m.state === "closed") && cfg.states.testing && t.status === cfg.states.testing)
    drift.push({ kind: "done-candidate", expected: cfg.states.done ?? undefined, actual: t.status });
  return { derived, drift };
}

export interface ApplyPlan {
  /** labels to add to the JIRA ticket first (JIRA spelling) */
  jiraAdd: string[];
  /** labels to remove per GitHub issue */
  gh: { n: number; remove: string[] }[];
  /** configured JIRA states to walk forward through (last = target); empty: no transition */
  transition: string[];
}

/** What applying a ticket's drift does on JIRA and GitHub (info kinds do nothing). */
export function planApply(t: JiraTicket, drift: DriftItem[], cfg: DriftConfig): ApplyPlan {
  const jiraAdd = new Map<string, string>();
  const byIssue = new Map<number, { n: number; remove: string[] }>();
  let transition: string[] = [];
  for (const d of drift) {
    if (d.kind === "label-on-gh" && d.issue && d.label) {
      if (!d.inJira) jiraAdd.set(jiraLabel(d.label).toLowerCase(), jiraLabel(d.label));
      const c = byIssue.get(d.issue) ?? { n: d.issue, remove: [] };
      c.remove.push(d.label);
      byIssue.set(d.issue, c);
    } else if (d.kind === "state-behind" && d.expected) {
      const index = (name: string | null | undefined) => (name ? cfg.statuses.findIndex((s) => s.name === name) : -1);
      const at = index(t.status);
      const goal = index(d.expected);
      transition = [cfg.states.selected, cfg.states.inProgress, cfg.states.testing].filter(
        (name): name is string => !!name && index(name) > at && index(name) <= goal,
      );
    }
  }
  return { jiraAdd: [...jiraAdd.values()], gh: [...byIssue.values()].sort((a, b) => a.n - b.n), transition };
}
