/** The shareable JIRA link for the team: the keys of all visible tickets as JQL, in board order. */
import type { Token } from "./filter";

export interface JiraConfig {
  baseUrl: string | null;
  projectKey: string | null;
  boardId: string | null;
}

export interface JiraLink {
  url: string;
  keys: string[];
}

/** null without a base URL or without any key. Duplicates go, order stays. */
export function jiraLink(cfg: JiraConfig, keys: (string | null | undefined)[]): JiraLink | null {
  if (!cfg.baseUrl) return null;
  const unique = [...new Set(keys.filter((k): k is string => !!k && /^[A-Z][A-Z0-9]+-\d+$/.test(k)))];
  if (!unique.length) return null;
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const jql = encodeURIComponent(`key in (${unique.join(", ")}) ORDER BY Rank ASC`);
  // a board view keeps the team in its usual board; it needs the project key, else derive it from the tickets
  const projectKey = cfg.projectKey || unique[0]?.split("-")[0];
  const url = cfg.boardId
    ? `${base}/jira/software/c/projects/${projectKey}/boards/${cfg.boardId}?jql=${jql}`
    : `${base}/issues/?jql=${jql}`;
  return { url, keys: unique };
}

/** Filter tokens that only exist on GitHub – named in the toast so nobody expects JIRA to filter by them. */
export const githubOnly = (tokens: Token[]) =>
  tokens.filter((t) => t.kind === "label" || t.kind === "nolabel" || t.kind === "assignee");
