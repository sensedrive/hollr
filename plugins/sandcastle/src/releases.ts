/**
 * Releases from version tags (pure, no I/O): a ticket is live from the first version tag whose range – the commits
 * since the previous version tag – holds a code commit naming its key. Merge commits name branches, not work, and
 * `docs` commits (spec, ADRs) ship nothing: neither counts. Tags never move, so a range is fetched once
 * (src/github.ts fetchReleases) and works for every ticket in the history, however old.
 */
import { isDocsTitle, keysIn } from "./pulls";
import type { Release, Released } from "./types";

const VERSION_TAG = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** vX.Y.Z or X.Y.Z – production versions; pre-releases (v2.0.0-rc.1) and other tags are no release. */
export const isVersionTag = (name: string) => VERSION_TAG.test(name);

/** Orders version tags by number (v1.10.0 after v1.9.0); only for names isVersionTag accepts. */
export function compareVersions(a: string, b: string): number {
  const pa = VERSION_TAG.exec(a)?.slice(1).map(Number) ?? [];
  const pb = VERSION_TAG.exec(b)?.slice(1).map(Number) ?? [];
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** A commit of a release range: its subject and whether it merges (more than one parent). */
export interface RangeCommit {
  subject: string;
  merge: boolean;
}

/** git's own revert subject („Revert "…"“) or the conventional type `revert` behind an optional gitmoji. */
const REVERT = /^\s*(?:Revert\b|(?:[^\w\s]+\s*|:[\w+-]+:\s*)?revert(?:\([^)]*\))?!?:)/i;

/**
 * JIRA keys of a range's code commits: not merges, not type `docs`, not reverts (they take work back, never ship
 * it); keys in any case („feat(tendr-956): …“).
 */
export function codeKeys(commits: RangeCommit[]): string[] {
  const keys = new Set<string>();
  for (const c of commits) {
    if (c.merge || isDocsTitle(c.subject) || REVERT.test(c.subject)) continue;
    for (const k of keysIn(c.subject.toUpperCase())) keys.add(k);
  }
  return [...keys];
}

/**
 * Ticket key → the first release with its code, and the later ones that shipped more of it – in the order the tags
 * were set (a hotfix v1.2.3 tagged after v1.3.0 went live after it), equal times by version.
 */
export function releasesByKey(releases: Release[]): Map<string, Released> {
  const out = new Map<string, Released>();
  for (const r of [...releases].sort((a, b) => a.at.localeCompare(b.at) || compareVersions(a.tag, b.tag))) {
    for (const k of r.keys) {
      const first = out.get(k);
      if (!first) out.set(k, { version: r.tag, at: r.at, later: [] });
      else first.later.push({ version: r.tag, at: r.at });
    }
  }
  return out;
}
