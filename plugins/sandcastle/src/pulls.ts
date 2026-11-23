/**
 * Pull requests as the board keeps them (pure, no I/O): GitHub's node turned into a Pull with the JIRA keys and
 * closed issues it names, and the mapping PR → JIRA ticket. A PR belongs to the tickets whose key its title or
 * head branch names (else its body); a PR without a known key belongs to the tickets whose GitHub family has an
 * issue it closes. A ticket can have several (the doc PR from the grill, the build PR from the run).
 */
import type { Family } from "./drift";
import type { ChecksState, Pull, PullOut, PullState } from "./types";

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
  headRefOid: string;
  baseRefName: string;
  updatedAt: string;
  body: string | null;
  reviewDecision?: string | null;
  commits?: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
  closingIssuesReferences: { nodes: { number: number }[] };
}

const KEY = /\b[A-Z][A-Z0-9]+-\d+\b/g;
const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)\b/gi;

export const keysIn = (text: string) => [...text.matchAll(KEY)].map((m) => m[0]);

/** Conventional type `docs` behind an optional gitmoji: „📝 docs: …“, „📄 docs(scope): …“, „:memo: docs: …“. */
const DOCS_TYPE = /^\s*(?:[^\w\s]+\s*|:[\w+-]+:\s*)?docs(?:\([^)]*\))?!?:/i;

/** A commit subject or PR title of type `docs` – documentation only, never the ticket's code. */
export const isDocsTitle = (title: string) => DOCS_TYPE.test(title);

/** A documentation PR: a grill doc PR (`docs/<KEY>-…`) or one titled with type `docs` (spec and ADRs ahead of the build). */
export const isDocsPull = (p: Pick<Pull, "title" | "branch">) => p.branch.startsWith("docs/") || isDocsTitle(p.title);

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
    head: n.headRefOid,
    mergedAt: n.mergedAt,
    closedAt: n.closedAt,
    updatedAt: n.updatedAt,
    keys: pullKeys(n.title, n.headRefName, body),
    // src/github.ts withCodeKeys fills them in for open PRs
    codeKeys: [],
    closes: pullCloses(
      n.closingIssuesReferences.nodes.map((r) => r.number),
      body,
    ),
  };
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
  docs: isDocsPull(p),
});

const RANK: Record<PullState, number> = { open: 0, draft: 1, merged: 2, closed: 3 };
const when = (p: Pull) => p.mergedAt ?? p.closedAt ?? p.updatedAt;

/** Open first, then drafts, merged, closed; newest first within each – the first one is the card's PR. */
export const comparePulls = (a: Pull, b: Pull) => RANK[a.state] - RANK[b.state] || when(b).localeCompare(when(a)) || b.n - a.n;

/**
 * Ticket key → its PRs (sorted, main PR first). A PR belongs to the tickets its title, head branch or code commits
 * name (a batch PR to all it builds); `known`: the ticket keys there are – keys a PR names that are no ticket
 * (UTF-8, ISO-8601) don't count, so such a PR still maps through the issues it closes.
 */
export function pullsByTicket(pulls: Pull[], known: ReadonlySet<string>, fam: ReadonlyMap<string, Family>): Map<string, PullOut[]> {
  const keyOf = new Map<number, string>();
  for (const [key, f] of fam) for (const m of [f.grill, f.story, ...f.children]) if (m) keyOf.set(m.n, key);
  const byKey = new Map<string, Pull[]>();
  for (const p of [...pulls].sort(comparePulls)) {
    const own = [...new Set([...p.keys, ...p.codeKeys])].filter((k) => known.has(k));
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
