// JIRA ticket keys (`TENDR-1037`) and GitHub issue/PR numbers (`#3575`) in a session's terminal and chat: what the
// `links` gate says about the pane's project decides which of them count. A tap opens the Sandcastle board on the
// ticket, else the GitHub/JIRA page. Same patterns as the iOS app.

/** The `links` gate's answer for one pane: its GitHub repo and JIRA project, each null when unknown. */
export interface LinkInfo {
  repo: string | null;
  jira: { baseUrl: string; keys: string[] } | null;
}

export const NO_LINKS: LinkInfo = { repo: null, jira: null };

/** Where a tap goes: the board deep link (`open` = `<KEY>:` or `:<n>`, `repo` for an issue) or the web page. */
export interface IssueTarget {
  open: string;
  repo?: string;
  web: string;
}

/** A match in a text: its range and the `hollr-issue:` href to hand to the link handler. */
export interface FoundIssue {
  start: number;
  end: number;
  url: string;
}

const SCHEME = "hollr-issue:";
const ISSUE_RE = /(?<![\w/&#])#(\d{1,6})\b/g;
/** URLs whose `#12` or `/browse/TENDR-1` already is part of a link */
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const KEY_RE = /^[A-Z][A-Z0-9]+$/;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** Ticket keys and issue numbers in `text`, in order, never inside a URL. */
export function findIssues(text: string, info: LinkInfo): FoundIssue[] {
  const urls = [...text.matchAll(URL_RE)].map((m) => [m.index, m.index + m[0].length] as const);
  const inUrl = (at: number) => urls.some(([s, e]) => at >= s && at < e);
  const out: FoundIssue[] = [];
  const keys = info.jira?.keys.filter((k) => KEY_RE.test(k)) ?? [];
  if (info.jira && keys.length) {
    const base = info.jira.baseUrl.replace(/\/+$/, "");
    const re = new RegExp(`\\b(${keys.join("|")})-(\\d+)\\b`, "g");
    for (const m of text.matchAll(re)) {
      if (inUrl(m.index)) continue;
      const key = `${m[1]}-${m[2]}`;
      out.push({ start: m.index, end: m.index + m[0].length, url: issueHref({ open: `${key}:`, web: `${base}/browse/${key}` }) });
    }
  }
  if (info.repo && REPO_RE.test(info.repo)) {
    for (const m of text.matchAll(ISSUE_RE)) {
      if (inUrl(m.index)) continue;
      const n = Number(m[1]);
      if (n < 1) continue;
      out.push({
        start: m.index,
        end: m.index + m[0].length,
        url: issueHref({ open: `:${n}`, repo: info.repo, web: `https://github.com/${info.repo}/issues/${n}` }),
      });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export function issueHref(t: IssueTarget): string {
  const q = new URLSearchParams({ open: t.open, web: t.web });
  if (t.repo) q.set("repo", t.repo);
  return `${SCHEME}?${q}`;
}

/** The target of a `hollr-issue:` href, else undefined (any other link). */
export function parseIssueHref(href: string): IssueTarget | undefined {
  if (!href.startsWith(SCHEME)) return undefined;
  const q = new URLSearchParams(href.slice(SCHEME.length).replace(/^\?/, ""));
  const open = q.get("open") ?? "";
  const web = q.get("web") ?? "";
  const repo = q.get("repo") ?? undefined;
  if (!/^(?:[A-Z][A-Z0-9]+-\d+:|:\d+)$/.test(open) || !/^https?:\/\//i.test(web)) return undefined;
  if (repo !== undefined && !REPO_RE.test(repo)) return undefined;
  return repo ? { open, repo, web } : { open, web };
}

/** The gate's answer checked field by field; anything malformed counts as unknown. */
export function parseLinkInfo(data: unknown): LinkInfo {
  const d = (data && typeof data === "object" ? data : {}) as { repo?: unknown; jira?: unknown };
  const repo = typeof d.repo === "string" && REPO_RE.test(d.repo) ? d.repo : null;
  const j = (d.jira && typeof d.jira === "object" ? d.jira : null) as { baseUrl?: unknown; keys?: unknown } | null;
  const keys = Array.isArray(j?.keys) ? j.keys.filter((k): k is string => typeof k === "string" && KEY_RE.test(k)) : [];
  const jira = j && typeof j.baseUrl === "string" && /^https?:\/\//i.test(j.baseUrl) && keys.length ? { baseUrl: j.baseUrl, keys } : null;
  return { repo, jira };
}
