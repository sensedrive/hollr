/**
 * Pull requests as the board keeps them (pure, no I/O): GitHub's node turned into a Pull with the JIRA keys and
 * closed issues it names, and the mapping PR → JIRA ticket. A PR belongs to the tickets whose key its title or
 * head branch names (else its body); a PR without a known key belongs to the tickets whose GitHub family has an
 * issue it closes. A ticket can have several (the doc PR from the grill, the build PR from the run).
 */
import type { Family } from "./drift";
import type { ChecksState, Pull, PullOut, PullState, Released, ReleasePull } from "./types";

/** The part of a PR body searched for keys and `Closes #n`. */
export const BODY_CHARS = 2000;

/** A pull request node as github.ts PULL_FIELDS selects it (review and checks only for open PRs). */
export interface PullNode {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  mergedAt: string | null;
  closedAt: string | null;
  headRefName: string;
  baseRefName: string;
  updatedAt: string;
  body: string | null;
  reviewDecision?: string | null;
  commits?: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
  closingIssuesReferences: { nodes: { number: number }[] };
}

const KEY = /\b[A-Z][A-Z0-9]+-\d+\b/g;
const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)\b/gi;

const keysIn = (text: string) => [...text.matchAll(KEY)].map((m) => m[0]);

/** JIRA keys of a PR: from title and head branch (any case), else from the body's start. */
export function pullKeys(title: string, branch: string, body: string): string[] {
  const own = [...keysIn(title), ...keysIn(branch.toUpperCase())];
  return [...new Set(own.length ? own : keysIn(body.slice(0, BODY_CHARS)))];
}

/** Issue numbers a PR closes: GitHub's closing references plus `Closes #n`/`Fixes #n`/`Resolves #n` in the body. */
export function pullCloses(refs: number[], body: string): number[] {
  const found = [...body.slice(0, BODY_CHARS).matchAll(CLOSES)].map((m) => Number(m[1]));
  return [...new Set([...refs, ...found])].sort((a, b) => a - b);
}

export function pullState(state: PullNode["state"], isDraft: boolean): PullState {
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  return isDraft ? "draft" : "open";
}

/** GitHub's status rollup of the last commit; EXPECTED (a required check not reported yet) counts as pending. */
export function checksState(rollup: string | null | undefined): ChecksState | null {
  switch (rollup) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return null;
  }
}

/** APPROVED → approved, CHANGES_REQUESTED → changes-requested, REVIEW_REQUIRED → review-required. */
export const reviewState = (decision: string | null | undefined): string | null =>
  decision ? decision.toLowerCase().replace(/_/g, "-") : null;

export function toPull(n: PullNode): Pull {
  const body = n.body ?? "";
  return {
    n: n.number,
    title: n.title,
    url: n.url,
    state: pullState(n.state, n.isDraft),
    checks: checksState(n.commits?.nodes[0]?.commit.statusCheckRollup?.state),
    review: reviewState(n.reviewDecision),
    branch: n.headRefName,
    base: n.baseRefName,
    mergedAt: n.mergedAt,
    closedAt: n.closedAt,
    updatedAt: n.updatedAt,
    keys: pullKeys(n.title, n.headRefName, body),
    closes: pullCloses(
      n.closingIssuesReferences.nodes.map((r) => r.number),
      body,
    ),
  };
}

/** A merged PR as release candidate, with every JIRA key of its title and whole body (changelogs are short). */
export function toRelease(n: PullNode): ReleasePull | null {
  if (n.state !== "MERGED" || !n.mergedAt) return null;
  const keys = [...new Set(keysIn(`${n.title}\n${n.body ?? ""}`))];
  return { n: n.number, title: n.title, url: n.url, base: n.baseRefName, branch: n.headRefName, mergedAt: n.mergedAt, keys };
}

const RELEASE_TITLE = /chore\(release\)|^\W*release\b/i;
const VERSION = /v\d+\.\d+\.\d+/;

/**
 * A release PR: merged into a branch other than the default one – the configured release branch, or else one whose
 * head is `release-prep/…` or whose title reads like a release („🔖 chore(release): v2.0.0“).
 */
export function isReleasePull(r: Pick<ReleasePull, "base" | "branch" | "title">, defaultBranch: string, releaseBranch: string | null): boolean {
  if (r.base === defaultBranch) return false;
  if (releaseBranch) return r.base === releaseBranch;
  return r.branch.startsWith("release-prep/") || RELEASE_TITLE.test(r.title);
}

/** Ticket key → the earliest release PR naming it (word-boundary key match in title or body). */
export function releasesByKey(releases: ReleasePull[], defaultBranch: string, releaseBranch: string | null): Map<string, Released> {
  const out = new Map<string, Released>();
  const sorted = releases.filter((r) => isReleasePull(r, defaultBranch, releaseBranch)).sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
  for (const r of sorted) {
    const version = (r.title.match(VERSION) ?? r.branch.match(VERSION))?.[0] ?? null;
    for (const k of r.keys) if (!out.has(k)) out.set(k, { version, at: r.mergedAt, pr: r.n });
  }
  return out;
}

export const pullOut = (p: Pull): PullOut => ({
  n: p.n,
  title: p.title,
  url: p.url,
  state: p.state,
  checks: p.checks,
  review: p.review,
  branch: p.branch,
  base: p.base,
  mergedAt: p.mergedAt,
});

const RANK: Record<PullState, number> = { open: 0, draft: 1, merged: 2, closed: 3 };
const when = (p: Pull) => p.mergedAt ?? p.closedAt ?? p.updatedAt;

/** Open first, then drafts, merged, closed; newest first within each – the first one is the card's PR. */
export const comparePulls = (a: Pull, b: Pull) => RANK[a.state] - RANK[b.state] || when(b).localeCompare(when(a)) || b.n - a.n;

/**
 * Ticket key → its PRs (sorted, main PR first). `known`: the ticket keys there are – keys a PR names that are no
 * ticket (UTF-8, ISO-8601) don't count, so such a PR still maps through the issues it closes.
 */
export function pullsByTicket(pulls: Pull[], known: ReadonlySet<string>, fam: ReadonlyMap<string, Family>): Map<string, PullOut[]> {
  const keyOf = new Map<number, string>();
  for (const [key, f] of fam) for (const m of [f.grill, f.story, ...f.children]) if (m) keyOf.set(m.n, key);
  const byKey = new Map<string, Pull[]>();
  for (const p of [...pulls].sort(comparePulls)) {
    const own = p.keys.filter((k) => known.has(k));
    const keys = own.length ? own : [...new Set(p.closes.map((n) => keyOf.get(n)).filter((k): k is string => !!k))];
    for (const k of keys) byKey.set(k, [...(byKey.get(k) ?? []), p]);
  }
  return new Map([...byKey].map(([k, ps]) => [k, ps.map(pullOut)]));
}

/** The PRs the Werkbank shows: those closing an issue of the board, with the issues they close. */
export function closingPulls(pulls: Pull[], issues: ReadonlySet<number>): (PullOut & { closes: number[] })[] {
  return [...pulls]
    .sort(comparePulls)
    .filter((p) => p.closes.some((n) => issues.has(n)))
    .map((p) => ({ ...pullOut(p), closes: p.closes }));
}
