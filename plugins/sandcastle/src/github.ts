/**
 * GitHub through `gh api graphql` (gh's login on this computer). One query per board – open issues, closed in the
 * last 14 days, labels, assignable users – paged 100 at a time, and beside it the pull requests (open, and merged
 * or closed in the last 30 days); every write is one mutation that answers the changed issue, so the cache can
 * take it as is.
 */
import { blockedByOf, jiraKeyOf, parentOf } from "./body";
import { firstLine, HttpError, run } from "./env";
import { type PullNode, toPull } from "./pulls";
import { codeKeys, compareVersions, isVersionTag, type RangeCommit } from "./releases";
import type { Assignee, Issue, LabelInfo, Pull, Release } from "./types";

/** Days the "Erledigt" column covers before „Ältere laden“. */
export const CLOSED_DAYS = 14;
const DAY = 86_400_000;

/** The repository as one board fetch sees it. */
export interface RepoSnapshot {
  repoId: string;
  viewer: string;
  /** with stories – the cache splits them off */
  issues: Issue[];
  /** open pull requests and those merged or closed in the last PULL_DAYS days */
  pulls: Pull[];
  /** every version tag with the JIRA keys of its code commits, oldest version first (src/releases.ts) */
  releases: Release[];
  /** the last release fetch failed: `releases` are those of the fetch before (null: they are current) */
  releasesError?: string | null;
  labels: (LabelInfo & { id: string })[];
  assignees: Assignee[];
  closedOlder: number;
}

const ISSUE_FIELDS = `fragment I on Issue {
  id number title state url updatedAt closedAt body
  author { login }
  labels(first: 50) { nodes { name } }
  assignees(first: 10) { nodes { login } }
  comments { totalCount }
}`;

/** An issue node as ISSUE_FIELDS selects it. */
export interface IssueNode {
  id: string;
  number: number;
  title: string;
  state: string;
  url: string;
  updatedAt: string;
  closedAt: string | null;
  body: string | null;
  author: { login: string } | null;
  labels: { nodes: { name: string }[] };
  assignees: { nodes: { login: string }[] };
  comments: { totalCount: number };
}

export function toIssue(n: IssueNode): Issue {
  const body = n.body ?? "";
  return {
    id: n.id,
    number: n.number,
    title: n.title,
    state: n.state === "CLOSED" ? "closed" : "open",
    labels: n.labels.nodes.map((l) => l.name),
    assignees: n.assignees.nodes.map((a) => a.login),
    // deleted accounts come back as null
    author: n.author?.login ?? "ghost",
    parent: parentOf(body) ?? null,
    jira: jiraKeyOf(body) ?? null,
    blockedBy: blockedByOf(body),
    updatedAt: n.updatedAt,
    closedAt: n.closedAt,
    url: n.url,
    commentsCount: n.comments.totalCount,
  };
}

function splitSlug(slug: string): { owner: string; name: string } {
  const [owner, name, ...rest] = slug.split("/");
  if (!owner || !name || rest.length) throw new HttpError(400, `Ungültiges Repo „${slug}“.`);
  return { owner, name };
}

interface GqlError {
  message: string;
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const r = await run(["gh", "api", "graphql", "--input", "-"], {
    stdin: JSON.stringify({ query, variables }),
    timeoutMs: 60_000,
  });
  let res: { data?: T; errors?: GqlError[] } | undefined;
  try {
    res = JSON.parse(r.out);
  } catch {}
  // gh exits 1 on GraphQL errors too, the JSON on stdout says which
  if (res?.errors?.length) throw new HttpError(502, `GitHub: ${[...new Set(res.errors.map((e) => e.message))].join("; ")}`);
  if (!r.ok || !res?.data) throw new HttpError(502, `gh: ${firstLine(r.err || r.out)}`);
  return res.data;
}

/** GitHub search's date form (UTC days). */
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const closedSearch = (slug: string, range: string) => `repo:${slug} is:issue is:closed closed:${range}`;

interface Page<N> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: N[];
}

/** Open issues stop at this many – the board is no archive. */
const MAX_OPEN = 500;

const OPEN_QUERY = `query Open($owner: String!, $name: String!, $dir: OrderDirection!, $after: String,
    $olderQ: String!, $withMeta: Boolean!) {
  viewer @include(if: $withMeta) { login }
  repository(owner: $owner, name: $name) {
    id
    issues(states: OPEN, first: 100, after: $after, orderBy: { field: CREATED_AT, direction: $dir }) {
      pageInfo { hasNextPage endCursor }
      nodes { ...I }
    }
    labels(first: 100, orderBy: { field: NAME, direction: ASC }) @include(if: $withMeta) { nodes { id name color } }
    assignableUsers(first: 100) @include(if: $withMeta) { nodes { login name avatarUrl } }
  }
  older: search(query: $olderQ, type: ISSUE, first: 1) @include(if: $withMeta) { issueCount }
}
${ISSUE_FIELDS}`;

interface OpenResult {
  viewer?: { login: string };
  repository: {
    id: string;
    issues: Page<IssueNode>;
    labels?: { nodes: (LabelInfo & { id: string })[] };
    assignableUsers?: { nodes: Assignee[] };
  } | null;
  older?: { issueCount: number };
}

const SEARCH_QUERY = `query Search($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ...I }
  }
}
${ISSUE_FIELDS}`;

/** All issues one search finds, page after page. */
async function searchAll(q: string): Promise<Issue[]> {
  const out: Issue[] = [];
  let after: string | null = null;
  do {
    const page: { search: Page<IssueNode | Record<string, never>> } = await graphql(SEARCH_QUERY, { q, after });
    // pull requests match the search too; `...I` leaves them empty
    for (const n of page.search.nodes) if (isNode(n)) out.push(toIssue(n));
    after = page.search.pageInfo.hasNextPage ? page.search.pageInfo.endCursor : null;
  } while (after);
  return out;
}

/** A search node the query's fragment filled (the others come back as `{}`). */
const isNode = <N extends { number: number }>(n: N | Record<string, never>): n is N => "number" in n;

/**
 * Closed issues of the days from..to, one search per day, all at once: GitHub answers one document's
 * fields one after another and search pages only by cursor, so parallel requests are what makes a busy
 * repo (tendr: ~400 closed in 14 days) load in one round trip instead of five.
 */
async function closedOnDays(slug: string, fromMs: number, toMs: number): Promise<Issue[]> {
  const days: string[] = [];
  for (let t = toMs; day(t) >= day(fromMs); t -= DAY) days.push(day(t));
  return (await Promise.all(days.map((d) => searchAll(closedSearch(slug, d))))).flat();
}

/**
 * Full fetch of a board. Open issues come in two page chains at once, oldest-first and newest-first, that stop
 * where they meet; the oldest-first chain's first page also brings labels, users, viewer and the count of
 * closed issues before the window. Closed issues come per day in parallel (closedOnDays), pull requests and
 * releases beside them (fetchPulls, fetchReleases). `prev`: the last snapshot – release ranges and the code keys
 * of unchanged PRs are kept.
 */
export async function fetchBoard(
  slug: string,
  now = Date.now(),
  prev: Pick<RepoSnapshot, "releases" | "pulls"> = { releases: [], pulls: [] },
): Promise<RepoSnapshot> {
  const { owner, name } = splitSlug(slug);
  const fromMs = now - CLOSED_DAYS * DAY;
  const open = new Map<number, Issue>();
  const reach = { asc: 0, desc: Number.POSITIVE_INFINITY };
  let meta: OpenResult | undefined;

  async function chain(dir: "ASC" | "DESC") {
    let after: string | null = null;
    for (let first = true; ; first = false) {
      const withMeta = first && dir === "ASC";
      const page: OpenResult = await graphql<OpenResult>(OPEN_QUERY, {
        owner,
        name,
        dir,
        after,
        olderQ: closedSearch(slug, `<${day(fromMs)}`),
        withMeta,
      });
      if (!page.repository) throw new HttpError(404, `Repo ${slug} nicht gefunden.`);
      if (withMeta) meta = page;
      for (const n of page.repository.issues.nodes) {
        open.set(n.number, toIssue(n));
        if (dir === "ASC") reach.asc = Math.max(reach.asc, n.number);
        else reach.desc = Math.min(reach.desc, n.number);
      }
      const { hasNextPage, endCursor } = page.repository.issues.pageInfo;
      if (!hasNextPage || reach.asc >= reach.desc || open.size >= MAX_OPEN) return;
      after = endCursor;
    }
  }

  const [closed, pulls, rel] = await Promise.all([
    closedOnDays(slug, fromMs, now),
    fetchPulls(owner, name, slug, now).then((pulls) => withCodeKeys(slug, pulls, prev.pulls)),
    // releases failing must not take the board down: keep the last ones and say why
    fetchReleases(owner, name, slug, prev.releases).then(
      (releases) => ({ releases, releasesError: null }),
      (err: unknown) => ({ releases: prev.releases, releasesError: err instanceof Error ? err.message : String(err) }),
    ),
    chain("ASC"),
    chain("DESC"),
  ]);
  const repo = meta?.repository;
  const issues = new Map(open);
  // an issue closed seconds ago can be in both lists while the search index catches up: closed wins
  for (const i of closed) if (i.closedAt && Date.parse(i.closedAt) >= Date.parse(day(fromMs))) issues.set(i.number, i);
  return {
    repoId: repo?.id ?? "",
    viewer: meta?.viewer?.login ?? "",
    issues: [...issues.values()],
    pulls,
    ...rel,
    labels: repo?.labels?.nodes ?? [],
    assignees: repo?.assignableUsers?.nodes ?? [],
    closedOlder: meta?.older?.issueCount ?? 0,
  };
}

/** Days of merged and closed pull requests a board keeps. */
export const PULL_DAYS = 30;
/** Days one search for merged/closed PRs covers – a busy repo (tendr: ~300 in 30 days) fits one page each. */
const PULL_WINDOW = 10;
/** Open pull requests stop at this many, like open issues. */
const MAX_PULLS = 500;

// review and checks cost GitHub seconds per page: only open PRs ask for them ($live)
const PULL_FIELDS = `fragment P on PullRequest {
  number title url state isDraft mergedAt closedAt headRefName headRefOid baseRefName updatedAt body
  reviewDecision @include(if: $live)
  commits(last: 1) @include(if: $live) { nodes { commit { statusCheckRollup { state } } } }
  closingIssuesReferences(first: 20) { nodes { number } }
}`;

const PULL_QUERY = `query Pulls($owner: String!, $name: String!, $states: [PullRequestState!]!, $after: String,
    $live: Boolean!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: $states, first: 100, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ...P }
    }
  }
}
${PULL_FIELDS}`;

const PULL_SEARCH = `query PullSearch($q: String!, $after: String, $live: Boolean!) {
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ...P }
  }
}
${PULL_FIELDS}`;

/** Pull requests of `states`, most recently updated first, page after page until one older than `since`. */
async function pullChain(owner: string, name: string, slug: string, states: string[], since: string | null): Promise<Pull[]> {
  const live = states.includes("OPEN");
  const out: Pull[] = [];
  let after: string | null = null;
  do {
    const page: { repository: { pullRequests: Page<PullNode> } | null } = await graphql(PULL_QUERY, {
      owner,
      name,
      states,
      after,
      live,
    });
    if (!page.repository) throw new HttpError(404, `Repo ${slug} nicht gefunden.`);
    const { nodes, pageInfo } = page.repository.pullRequests;
    for (const n of nodes) if (!since || n.updatedAt >= since) out.push(toPull(n));
    const last = nodes[nodes.length - 1];
    const done = !pageInfo.hasNextPage || (!!since && !!last && last.updatedAt < since) || out.length >= MAX_PULLS;
    after = done ? null : pageInfo.endCursor;
  } while (after);
  return out;
}

/** Merged or closed PRs of one search, page after page. */
async function searchPullNodes(q: string): Promise<PullNode[]> {
  const out: PullNode[] = [];
  let after: string | null = null;
  do {
    const page: { search: Page<PullNode | Record<string, never>> } = await graphql(PULL_SEARCH, { q, after, live: false });
    for (const n of page.search.nodes) if (isNode(n)) out.push(n);
    after = page.search.pageInfo.hasNextPage ? page.search.pageInfo.endCursor : null;
  } while (after);
  return out;
}

const TAGS_QUERY = `query Tags($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    refs(refPrefix: "refs/tags/", first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        target {
          oid
          ... on Commit { committedDate }
          ... on Tag { tagger { date } target { oid ... on Commit { committedDate } } }
        }
      }
    }
  }
}`;

/** A tag ref as TAGS_QUERY selects it: lightweight (target is the commit) or annotated (target is a Tag). */
interface TagNode {
  name: string;
  target: { oid: string; committedDate?: string; tagger?: { date: string } | null; target?: { oid: string; committedDate?: string } };
}

/** Version tags (src/releases.ts isVersionTag), oldest version first: the commit each points at and when it was set. */
async function versionTags(owner: string, name: string, slug: string): Promise<{ tag: string; oid: string; at: string }[]> {
  const out: { tag: string; oid: string; at: string }[] = [];
  let after: string | null = null;
  do {
    const page: { repository: { refs: Page<TagNode> } | null } = await graphql(TAGS_QUERY, { owner, name, after });
    if (!page.repository) throw new HttpError(404, `Repo ${slug} nicht gefunden.`);
    for (const n of page.repository.refs.nodes) {
      const commit = n.target.target ?? n.target;
      const at = n.target.tagger?.date ?? commit.committedDate;
      // a tag on something other than a commit carries no date: no release
      if (isVersionTag(n.name) && at) out.push({ tag: n.name, oid: commit.oid, at: new Date(at).toISOString() });
    }
    after = page.repository.refs.pageInfo.hasNextPage ? page.repository.refs.pageInfo.endCursor : null;
  } while (after);
  return out.sort((a, b) => compareVersions(a.tag, b.tag));
}

const HISTORY_QUERY = `query History($owner: String!, $name: String!, $oid: GitObjectID!, $after: String) {
  repository(owner: $owner, name: $name) {
    object(oid: $oid) {
      ... on Commit {
        history(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { message parents { totalCount } }
        }
      }
    }
  }
}`;

/** The whole history up to `oid` – the first release's range. */
async function historyCommits(owner: string, name: string, slug: string, oid: string): Promise<RangeCommit[]> {
  const out: RangeCommit[] = [];
  let after: string | null = null;
  do {
    const page: {
      repository: { object: { history?: Page<{ message: string; parents: { totalCount: number } }> } | null } | null;
    } = await graphql(HISTORY_QUERY, { owner, name, oid, after });
    const history = page.repository?.object?.history;
    if (!history) throw new HttpError(502, `GitHub: Commit ${oid} in ${slug} nicht gefunden.`);
    for (const c of history.nodes) out.push({ subject: c.message.split("\n", 1)[0] ?? "", merge: c.parents.totalCount > 1 });
    after = history.pageInfo.hasNextPage ? history.pageInfo.endCursor : null;
  } while (after);
  return out;
}

/** Commits in `head` but not in `base` – GitHub's compare, 100 a page; subjects only. */
async function rangeCommits(slug: string, base: string, head: string): Promise<RangeCommit[]> {
  const r = await run(
    [
      "gh",
      "api",
      "--paginate",
      `repos/${slug}/compare/${base}...${head}?per_page=100`,
      "--jq",
      '.commits[] | [(.parents | length), (.commit.message | split("\\n")[0])] | @tsv',
    ],
    { timeoutMs: 120_000 },
  );
  if (!r.ok) throw new HttpError(502, `gh: ${firstLine(r.err || r.out)}`);
  return r.out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      return { subject: line.slice(tab + 1), merge: Number(line.slice(0, tab)) > 1 };
    });
}

/** Compares at once (release ranges, PR commits): a first fetch of a repo with many tags stays within GitHub's limits. */
const RANGE_PARALLEL = 4;

/** `fn` for every item, RANGE_PARALLEL at a time; the first failure fails the whole. */
async function eachLimited<T>(items: readonly T[], fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  async function worker() {
    for (let i = next++; i < items.length; i = next++) {
      const item = items[i];
      if (item !== undefined) await fn(item, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(RANGE_PARALLEL, items.length) }, worker));
}

/**
 * Every version tag with the JIRA keys of its code commits. A range – the commits since the previous version tag,
 * the whole history for the first – is fetched only when `known` has none for the same tag, commit and base: tags
 * don't move, so once the history is in, only a new release costs requests. Any failure fails the whole list (the
 * caller keeps the last one): a list with a range missing would move tickets to a later release.
 */
async function fetchReleases(owner: string, name: string, slug: string, known: Release[]): Promise<Release[]> {
  const tags = await versionTags(owner, name, slug);
  const cached = new Map(known.map((r) => [r.tag, r]));
  const out: Release[] = [];
  await eachLimited(tags, async (t, i) => {
    const base = tags[i - 1]?.oid ?? null;
    const hit = cached.get(t.tag);
    if (hit && hit.oid === t.oid && hit.base === base) out[i] = { ...hit, at: t.at };
    else {
      const commits = base ? await rangeCommits(slug, base, t.oid) : await historyCommits(owner, name, slug, t.oid);
      out[i] = { tag: t.tag, oid: t.oid, base, at: t.at, keys: codeKeys(commits) };
    }
  });
  return out;
}

/**
 * Open PRs, and the ones merged or closed in the PULL_DAYS before `now` – those in PULL_WINDOW-day searches at
 * once (like closedOnDays: one cursor chain would take a round trip per 100).
 */
async function fetchPulls(owner: string, name: string, slug: string, now: number): Promise<Pull[]> {
  const fromMs = now - PULL_DAYS * DAY;
  const ranges: string[] = [];
  for (let to = now; day(to) >= day(fromMs); to -= PULL_WINDOW * DAY)
    ranges.push(`${day(Math.max(fromMs, to - (PULL_WINDOW - 1) * DAY))}..${day(to)}`);
  const [open, ...ended] = await Promise.all([
    pullChain(owner, name, slug, ["OPEN"], null),
    ...ranges.map(async (r) => (await searchPullNodes(`repo:${slug} is:pr is:closed closed:${r}`)).map(toPull)),
  ]);
  return [...open, ...ended.flat()];
}

/** Open PRs and the merged or closed ones updated since `since` (the search index may lag; this does not). */
async function changedPulls(owner: string, name: string, slug: string, since: string): Promise<Pull[]> {
  const [open, ended] = await Promise.all([
    pullChain(owner, name, slug, ["OPEN"], null),
    pullChain(owner, name, slug, ["MERGED", "CLOSED"], since),
  ]);
  return [...open, ...ended];
}

/**
 * Pulls with the JIRA keys of their code commits (src/releases.ts codeKeys): read from GitHub's compare for an open
 * PR whose head is new; an unchanged PR, and a merged or closed one, keeps what `prev` found.
 */
async function withCodeKeys(slug: string, pulls: Pull[], prev: Pull[]): Promise<Pull[]> {
  const before = new Map(prev.map((p) => [p.n, p]));
  const out = pulls.map((p) => {
    const b = before.get(p.n);
    const open = p.state === "open" || p.state === "draft";
    return b && (b.head === p.head || !open) ? { ...p, codeKeys: b.codeKeys ?? [] } : p;
  });
  const todo = out.filter((p) => (p.state === "open" || p.state === "draft") && before.get(p.n)?.head !== p.head);
  await eachLimited(todo, async (p) => {
    p.codeKeys = codeKeys(await rangeCommits(slug, p.base, p.head));
  });
  return out;
}

const CHANGED_QUERY = `query Changed($owner: String!, $name: String!, $since: DateTime!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(states: [OPEN, CLOSED], first: 100, after: $after, filterBy: { since: $since },
        orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ...I }
    }
  }
}
${ISSUE_FIELDS}`;

/** What changed since a fetch: issues and pull requests updated since then, and every open pull request. */
export interface Changes {
  issues: Issue[];
  /** open PRs are always all here – a CI result doesn't touch a PR's updatedAt */
  pulls: Pull[];
}

/**
 * Issues (open or closed) and pull requests updated at or after `since` – the cheap refresh between full fetches.
 * `prev`: the pulls known so far, whose code keys are kept while their head stays.
 */
export async function fetchChanged(slug: string, since: string, prev: Pull[] = []): Promise<Changes> {
  const { owner, name } = splitSlug(slug);
  async function issues(): Promise<Issue[]> {
    const out: Issue[] = [];
    let after: string | null = null;
    do {
      const page: { repository: { issues: Page<IssueNode> } | null } = await graphql(CHANGED_QUERY, {
        owner,
        name,
        since,
        after,
      });
      if (!page.repository) throw new HttpError(404, `Repo ${slug} nicht gefunden.`);
      out.push(...page.repository.issues.nodes.map(toIssue));
      after = page.repository.issues.pageInfo.hasNextPage ? page.repository.issues.pageInfo.endCursor : null;
    } while (after);
    return out;
  }
  const [changed, pulls] = await Promise.all([issues(), changedPulls(owner, name, slug, since).then((p) => withCodeKeys(slug, p, prev))]);
  return { issues: changed, pulls };
}

const OLDER_QUERY = `query Older($q: String!) { search(query: $q, type: ISSUE, first: 1) { issueCount } }`;

/** How many CLOSED_DAYS windows one „Ältere laden“ looks back at most for anything at all. */
const MAX_WINDOWS = 12;

/**
 * Closed issues in the CLOSED_DAYS before the day of `before` (further back while a window is empty), and how
 * many are older still.
 */
export async function fetchClosedBefore(
  slug: string,
  before: string,
): Promise<{ issues: Issue[]; closedOlder: number }> {
  splitSlug(slug);
  const end = Date.parse(before);
  if (Number.isNaN(end)) throw new HttpError(400, "Ungültiges Datum in „before“.");
  // GitHub search compares whole days: the window ends the day before `before` (that day is already shown)
  let to = end - DAY;
  for (let w = 0; w < MAX_WINDOWS; w++) {
    const from = to - (CLOSED_DAYS - 1) * DAY;
    const [issues, older] = await Promise.all([
      closedOnDays(slug, from, to),
      graphql<{ search: { issueCount: number } }>(OLDER_QUERY, { q: closedSearch(slug, `<${day(from)}`) }),
    ]);
    const closedOlder = older.search.issueCount;
    if (issues.length || !closedOlder) return { issues, closedOlder };
    to = from - DAY;
  }
  return { issues: [], closedOlder: 0 };
}

const ISSUE_QUERY = `query Issue($owner: String!, $name: String!, $n: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $n) {
      ...I
      thread: comments(last: 100) { nodes { author { login } createdAt body } }
    }
  }
}
${ISSUE_FIELDS}`;

export interface RawComment {
  author: { login: string } | null;
  createdAt: string;
  body: string;
}

export async function fetchIssue(slug: string, n: number): Promise<{ issue: Issue; body: string; comments: RawComment[] }> {
  const { owner, name } = splitSlug(slug);
  const data = await graphql<{
    repository: { issue: (IssueNode & { thread: { nodes: RawComment[] } }) | null } | null;
  }>(ISSUE_QUERY, { owner, name, n });
  const node = data.repository?.issue;
  if (!node) throw new HttpError(404, `Issue #${n} nicht gefunden.`);
  return { issue: toIssue(node), body: node.body ?? "", comments: node.thread.nodes };
}

/**
 * Reopen, labels on/off, close – one mutation document whose fields GitHub runs in this order; answers the
 * issue after the last one (null: nothing to change). Label ids come from the board's label list.
 */
export async function updateIssue(
  issueId: string,
  change: { addLabelIds: string[]; removeLabelIds: string[]; reopen: boolean; close: boolean },
): Promise<Issue | null> {
  const vars: string[] = ["$id: ID!"];
  const parts: string[] = [];
  if (change.reopen) parts.push("reopenIssue(input: { issueId: $id }) { issue { ...I } }");
  if (change.addLabelIds.length) {
    vars.push("$add: [ID!]!");
    parts.push("addLabelsToLabelable(input: { labelableId: $id, labelIds: $add }) { labelable { ...I } }");
  }
  if (change.removeLabelIds.length) {
    vars.push("$remove: [ID!]!");
    parts.push("removeLabelsFromLabelable(input: { labelableId: $id, labelIds: $remove }) { labelable { ...I } }");
  }
  if (change.close) parts.push("closeIssue(input: { issueId: $id }) { issue { ...I } }");
  if (!parts.length) return null;
  const fields = parts.map((p, i) => `m${i}: ${p}`).join("\n");
  const data = await graphql<Record<string, { issue?: IssueNode; labelable?: IssueNode }>>(
    `mutation Update(${vars.join(", ")}) {\n${fields}\n}\n${ISSUE_FIELDS}`,
    {
      id: issueId,
      ...(change.addLabelIds.length && { add: change.addLabelIds }),
      ...(change.removeLabelIds.length && { remove: change.removeLabelIds }),
    },
  );
  const last = data[`m${parts.length - 1}`];
  const node = last?.issue ?? last?.labelable;
  if (!node) throw new HttpError(502, "GitHub: keine Antwort zur Änderung.");
  return toIssue(node);
}

export async function addComment(issueId: string, body: string): Promise<RawComment & { commentsCount: number }> {
  const data = await graphql<{
    addComment: { commentEdge: { node: RawComment }; subject: { comments: { totalCount: number } } };
  }>(
    `mutation Comment($id: ID!, $body: String!) {
      addComment(input: { subjectId: $id, body: $body }) {
        commentEdge { node { author { login } createdAt body } }
        subject { ... on Issue { comments { totalCount } } }
      }
    }`,
    { id: issueId, body },
  );
  return { ...data.addComment.commentEdge.node, commentsCount: data.addComment.subject.comments.totalCount };
}

export async function createIssue(repoId: string, title: string, body: string, labelIds: string[]): Promise<Issue> {
  const data = await graphql<{ createIssue: { issue: IssueNode } }>(
    `mutation Create($repo: ID!, $title: String!, $body: String!, $labels: [ID!]) {
      createIssue(input: { repositoryId: $repo, title: $title, body: $body, labelIds: $labels }) { issue { ...I } }
    }
    ${ISSUE_FIELDS}`,
    { repo: repoId, title, body, labels: labelIds },
  );
  return toIssue(data.createIssue.issue);
}
