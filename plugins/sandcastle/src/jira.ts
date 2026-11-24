/**
 * JIRA Cloud through REST v3 with the machine's API token (`~/.config/hollr/secrets.json`, written by the
 * `secrets` gate). Reads: a board snapshot per project (statuses in workflow order + tickets), changes since
 * the last fetch, one ticket's detail; writes: transitions by target status name, labels, comments. The token
 * goes into the Authorization header only – never into logs, errors or answers.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HttpError } from "./env";
import type { Project } from "./types";

export type StatusCategory = "new" | "indeterminate" | "done";

export interface JiraStatus {
  name: string;
  category: StatusCategory;
}

export interface JiraTicket {
  key: string;
  summary: string;
  status: string;
  category: StatusCategory;
  labels: string[];
  assignee: { accountId: string; name: string; avatarUrl: string | null } | null;
  type: string;
  subtask: boolean;
  /** the parent with hierarchy level 1 (epic) */
  epic: { key: string; summary: string } | null;
  /** the parent of a sub-task */
  parent: string | null;
  priority: string | null;
  created: string;
  updated: string;
}

export interface JiraSnapshot {
  /** workflow order: category new → indeterminate → done, inside by the project's configured states */
  statuses: JiraStatus[];
  tickets: JiraTicket[];
}

export interface JiraTransition {
  id: string;
  name: string;
  to: string;
  category: StatusCategory;
}

export interface JiraComment {
  author: string;
  created: string;
  text: string;
}

export interface JiraDetail {
  ticket: JiraTicket;
  description: string;
  comments: JiraComment[];
  transitions: JiraTransition[];
}

export interface JiraCredentials {
  site: string;
  email: string;
  token: string;
}

export type JiraStates = Project["jira"]["states"];

export const secretsFile = () =>
  process.env.HOLLR_SECRETS_FILE ?? join(homedir(), ".config", "hollr", "secrets.json");

/** The stored JIRA access, read anew each time (the user may add it while the plugin runs); null without one. */
export function jiraCredentials(file = secretsFile()): JiraCredentials | null {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"))?.jira;
    if (typeof j?.site !== "string" || typeof j?.email !== "string" || typeof j?.token !== "string") return null;
    if (!j.site || !j.email || !j.token) return null;
    return { site: j.site.replace(/^https?:\/\//i, "").replace(/\/+$/, ""), email: j.email, token: j.token };
  } catch {
    return null;
  }
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const FIELDS = ["summary", "status", "labels", "assignee", "issuetype", "parent", "updated", "created", "priority"];
const PAGE = 100;
const CATEGORY_ORDER: StatusCategory[] = ["new", "indeterminate", "done"];
/** Days a done ticket stays on the board (same window as GitHub's "Erledigt"). */
export const DONE_DAYS = 14;
/** our clock vs JIRA's, and updates landing while a fetch runs */
const SKEW_MS = 2 * 60_000;
const KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
export const PROJECT_KEY = /^[A-Z][A-Z0-9_]*$/;

const category = (key: unknown): StatusCategory =>
  key === "done" ? "done" : key === "indeterminate" ? "indeterminate" : "new";

interface RawStatus {
  name: string;
  statusCategory?: { key?: string };
}

interface RawIssue {
  key: string;
  fields: {
    summary?: string;
    status?: RawStatus;
    labels?: string[];
    assignee?: { accountId: string; displayName?: string; avatarUrls?: Record<string, string> } | null;
    issuetype?: { name?: string; subtask?: boolean; hierarchyLevel?: number };
    parent?: { key: string; fields?: { summary?: string; issuetype?: { hierarchyLevel?: number; name?: string } } };
    priority?: { name?: string } | null;
    updated?: string;
    created?: string;
    description?: unknown;
    comment?: { comments?: { author?: { displayName?: string }; created: string; body?: unknown }[] };
  };
}

export function toTicket(raw: RawIssue): JiraTicket {
  const f = raw.fields;
  const parent = f.parent;
  const parentIsEpic =
    !!parent && (parent.fields?.issuetype?.hierarchyLevel === 1 || parent.fields?.issuetype?.name === "Epic");
  return {
    key: raw.key,
    summary: f.summary ?? "",
    status: f.status?.name ?? "",
    category: category(f.status?.statusCategory?.key),
    labels: f.labels ?? [],
    assignee: f.assignee
      ? {
          accountId: f.assignee.accountId,
          name: f.assignee.displayName ?? f.assignee.accountId,
          avatarUrl: f.assignee.avatarUrls?.["48x48"] ?? null,
        }
      : null,
    type: f.issuetype?.name ?? "",
    subtask: !!f.issuetype?.subtask,
    epic: parent && parentIsEpic ? { key: parent.key, summary: parent.fields?.summary ?? "" } : null,
    parent: parent && !parentIsEpic ? parent.key : null,
    priority: f.priority?.name ?? null,
    created: f.created ?? "",
    updated: f.updated ?? "",
  };
}

/**
 * Unique statuses of the project's main issue types (sub-tasks left out) in workflow order: by category
 * new → indeterminate → done; inside a category the configured states keep their order (selected, inProgress,
 * testing, done). Unconfigured statuses keep JIRA's order – before the configured ones while nothing has been
 * started (Backlog before Selected), after them once work is under way (Blocked after Testing).
 */
export function orderStatuses(
  types: { subtask?: boolean; statuses?: RawStatus[] }[],
  states: JiraStates,
): JiraStatus[] {
  const seen = new Map<string, JiraStatus>();
  for (const t of types)
    if (!t.subtask)
      for (const s of t.statuses ?? [])
        if (!seen.has(s.name)) seen.set(s.name, { name: s.name, category: category(s.statusCategory?.key) });
  const configured = [states.selected, states.inProgress, states.testing, states.done];
  const rank = (s: JiraStatus, i: number) => {
    const c = configured.indexOf(s.name);
    if (c >= 0) return 1000 + c;
    return s.category === "new" ? i : 2000 + i;
  };
  return [...seen.values()]
    .map((s, i) => ({ s, cat: CATEGORY_ORDER.indexOf(s.category), r: rank(s, i) }))
    .sort((a, b) => a.cat - b.cat || a.r - b.r)
    .map((x) => x.s);
}

// ---------------------------------------------------------------- ADF

interface AdfNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
  content?: AdfNode[];
}

const SAFE_URL = /^https?:\/\//i;
const attr = (n: AdfNode, k: string) => {
  const v = n.attrs?.[k];
  return typeof v === "string" || typeof v === "number" ? String(v) : "";
};

function inline(nodes: AdfNode[] | undefined): string {
  let out = "";
  for (const n of nodes ?? []) {
    switch (n.type) {
      case "text": {
        let t = n.text ?? "";
        for (const m of n.marks ?? []) {
          if (m.type === "code") t = `\`${t}\``;
          else if (m.type === "strong") t = `**${t}**`;
          else if (m.type === "em") t = `_${t}_`;
          else if (m.type === "link") {
            const href = typeof m.attrs?.href === "string" ? m.attrs.href : "";
            if (SAFE_URL.test(href)) t = `[${t}](${href})`;
          }
        }
        out += t;
        break;
      }
      case "hardBreak":
        out += "\n";
        break;
      case "mention":
      case "status":
        out += attr(n, "text");
        break;
      case "emoji":
        out += attr(n, "text") || attr(n, "shortName");
        break;
      case "inlineCard":
        out += attr(n, "url");
        break;
      case "date": {
        const ms = Number(attr(n, "timestamp"));
        out += Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : "";
        break;
      }
      default:
        out += n.content ? inline(n.content) : (n.text ?? "");
    }
  }
  return out;
}

const indent = (text: string, prefix: string, first = prefix) =>
  text
    .split("\n")
    .map((l, i) => (i === 0 ? first : prefix) + l)
    .join("\n");

function blocks(nodes: AdfNode[] | undefined): string {
  return (nodes ?? [])
    .map(block)
    .filter((b) => b.trim())
    .join("\n\n");
}

function block(n: AdfNode): string {
  switch (n.type) {
    case "paragraph":
      return inline(n.content);
    case "heading":
      return `${"#".repeat(Math.min(Math.max(Number(attr(n, "level")) || 1, 1), 6))} ${inline(n.content)}`;
    case "bulletList":
      return (n.content ?? []).map((li) => indent(blocks(li.content), "  ", "- ")).join("\n");
    case "orderedList":
      return (n.content ?? []).map((li, i) => indent(blocks(li.content), "   ", `${i + 1}. `)).join("\n");
    case "codeBlock":
      return `\`\`\`\n${inline(n.content)}\n\`\`\``;
    case "blockquote":
      return indent(blocks(n.content), "> ");
    case "rule":
      return "---";
    case "table":
      return (n.content ?? [])
        .map((row) => (row.content ?? []).map((cell) => blocks(cell.content).replace(/\n+/g, " ")).join(" | "))
        .join("\n");
    case "mediaSingle":
    case "mediaGroup":
    case "media":
      return "[Anhang]";
    case "expand":
    case "nestedExpand":
      return [attr(n, "title"), blocks(n.content)].filter(Boolean).join("\n\n");
    default:
      return n.content ? blocks(n.content) : (n.text ?? "");
  }
}

/** Atlassian Document Format → plain text with a little Markdown (headings, lists, links, code). */
export function adfToText(doc: unknown): string {
  if (typeof doc === "string") return doc;
  if (!doc || typeof doc !== "object") return "";
  return block(doc as AdfNode).trim();
}

/** Plain text → ADF: blank lines separate paragraphs, single newlines become hard breaks. */
export function textToAdf(text: string): AdfNode & { version: 1 } {
  return {
    version: 1,
    type: "doc",
    content: text
      .trim()
      .split(/\n{2,}/)
      .map((p) => ({
        type: "paragraph",
        content: p.split("\n").flatMap((line, i): AdfNode[] => [
          ...(i ? [{ type: "hardBreak" }] : []),
          ...(line ? [{ type: "text", text: line }] : []),
        ]),
      })),
  };
}

// ---------------------------------------------------------------- client

export class JiraClient {
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(
    private creds: JiraCredentials,
    private fetcher: Fetch = fetch,
    private timeoutMs = 20_000,
    private parallel = 4,
  ) {}

  get site(): string {
    return this.creds.site;
  }

  /** One REST call, at most `parallel` at a time. JIRA errors become 4xx/502 with JIRA's own message. */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (this.active >= this.parallel) {
      // the finishing request hands its slot over, so `active` stays as it is
      const { promise, resolve } = Promise.withResolvers<void>();
      this.waiting.push(resolve);
      await promise;
    } else this.active++;
    try {
      return await this.send<T>(method, path, body);
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const auth = Buffer.from(`${this.creds.email}:${this.creds.token}`).toString("base64");
    let res: Response;
    try {
      res = await this.fetcher(`https://${this.creds.site}${path}`, {
        method,
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new HttpError(502, timeout ? "JIRA antwortet nicht (Zeitüberschreitung)." : "JIRA ist nicht erreichbar.");
    }
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401 || res.status === 403)
        throw new HttpError(502, `JIRA lehnt den Zugang ab (${res.status}) – Token in Hollr prüfen.`);
      let detail = "";
      try {
        const e = JSON.parse(text) as { errorMessages?: string[]; errors?: Record<string, string> };
        detail = [...(e.errorMessages ?? []), ...Object.values(e.errors ?? {})].join("; ");
      } catch {}
      throw new HttpError(res.status === 404 ? 404 : 502, `JIRA ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** All tickets of a JQL query, page by page (nextPageToken). */
  async search(jql: string): Promise<JiraTicket[]> {
    const out: JiraTicket[] = [];
    let nextPageToken: string | undefined;
    do {
      const page = await this.request<{ issues?: RawIssue[]; nextPageToken?: string; isLast?: boolean }>(
        "POST",
        "/rest/api/3/search/jql",
        { jql, fields: FIELDS, maxResults: PAGE, ...(nextPageToken ? { nextPageToken } : {}) },
      );
      out.push(...(page.issues ?? []).map(toTicket));
      nextPageToken = page.isLast ? undefined : page.nextPageToken;
    } while (nextPageToken);
    return out;
  }

  /** Statuses in workflow order and the tickets not done, or done in the last DONE_DAYS. */
  async fetchBoard(projectKey: string, states: JiraStates): Promise<JiraSnapshot> {
    const key = checkProjectKey(projectKey);
    const done = states.done ? `status changed to ${jqlString(states.done)} after -${DONE_DAYS}d` : `resolved >= -${DONE_DAYS}d`;
    const [types, tickets] = await Promise.all([
      this.request<{ subtask?: boolean; statuses?: RawStatus[] }[]>("GET", `/rest/api/3/project/${key}/statuses`),
      this.search(`project = ${key} AND (statusCategory != Done OR ${done}) ORDER BY Rank ASC`),
    ]);
    return { statuses: orderStatuses(types, states), tickets };
  }

  /** Tickets updated since `since` (ISO), with a margin for clock skew – the cheap refresh between full fetches. */
  fetchChanged(projectKey: string, since: string, now = Date.now()): Promise<JiraTicket[]> {
    const key = checkProjectKey(projectKey);
    // relative minutes: JQL dates are read in the JIRA user's time zone, offsets are not
    const minutes = Math.max(1, Math.ceil((now - Date.parse(since) + SKEW_MS) / 60_000));
    return this.search(`project = ${key} AND updated >= -${minutes}m ORDER BY Rank ASC`);
  }

  /** At most `max` tickets of the project whose text matches `text`, newest first – one page, no paging. */
  async searchText(projectKey: string, text: string, max: number): Promise<JiraTicket[]> {
    const key = checkProjectKey(projectKey);
    const page = await this.request<{ issues?: RawIssue[] }>("POST", "/rest/api/3/search/jql", {
      jql: `project = ${key} AND text ~ ${jqlString(text)} ORDER BY updated DESC`,
      fields: FIELDS,
      maxResults: max,
    });
    return (page.issues ?? []).map(toTicket);
  }

  async ticket(key: string): Promise<JiraTicket> {
    return toTicket(await this.request<RawIssue>("GET", `/rest/api/3/issue/${checkKey(key)}?fields=${FIELDS.join(",")}`));
  }

  async transitions(key: string): Promise<JiraTransition[]> {
    const r = await this.request<{
      transitions?: { id: string; name: string; to?: { name?: string; statusCategory?: { key?: string } } }[];
    }>("GET", `/rest/api/3/issue/${checkKey(key)}/transitions`);
    return (r.transitions ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      to: t.to?.name ?? t.name,
      category: category(t.to?.statusCategory?.key),
    }));
  }

  async detail(key: string): Promise<JiraDetail> {
    const k = checkKey(key);
    const [raw, transitions] = await Promise.all([
      this.request<RawIssue>("GET", `/rest/api/3/issue/${k}?fields=${[...FIELDS, "description", "comment"].join(",")}`),
      this.transitions(k),
    ]);
    return {
      ticket: toTicket(raw),
      description: adfToText(raw.fields.description),
      comments: (raw.fields.comment?.comments ?? []).map((c) => ({
        author: c.author?.displayName ?? "unbekannt",
        created: c.created,
        text: adfToText(c.body),
      })),
      transitions,
    };
  }

  /** Moves the ticket to the status named `to`; 409 when no transition from the current status leads there. */
  async transition(key: string, to: string): Promise<void> {
    const k = checkKey(key);
    const t = (await this.transitions(k)).find((x) => x.to === to);
    if (!t) throw new HttpError(409, `${k} kann von hier nicht nach „${to}“ wechseln.`);
    await this.request("POST", `/rest/api/3/issue/${k}/transitions`, { transition: { id: t.id } });
  }

  /**
   * Moves forward along `path` (the configured states after the current one, ending at the target): each round
   * takes the farthest step the workflow offers right now, so a direct transition wins over intermediate ones.
   */
  async transitionForward(key: string, path: string[]): Promise<void> {
    const k = checkKey(key);
    let rest = path;
    while (rest.length) {
      const available = await this.transitions(k);
      let step = -1;
      let id = "";
      for (let i = rest.length - 1; i >= 0 && step < 0; i--) {
        const t = available.find((x) => x.to === rest[i]);
        if (t) {
          step = i;
          id = t.id;
        }
      }
      if (step < 0) throw new HttpError(409, `${k} kann von hier nicht nach „${rest.at(-1)}“ wechseln.`);
      await this.request("POST", `/rest/api/3/issue/${k}/transitions`, { transition: { id } });
      rest = rest.slice(step + 1);
    }
  }

  async setLabels(key: string, add: string[], remove: string[]): Promise<void> {
    const bad = [...add, ...remove].filter((l) => !/^\S{1,255}$/.test(l));
    if (bad.length) throw new HttpError(400, `Ungültige Labels (keine Leerzeichen erlaubt): ${bad.join(", ")}`);
    if (!add.length && !remove.length) return;
    await this.request("PUT", `/rest/api/3/issue/${checkKey(key)}`, {
      update: { labels: [...add.map((l) => ({ add: l })), ...remove.map((l) => ({ remove: l }))] },
    });
  }

  async comment(key: string, text: string): Promise<JiraComment> {
    const c = await this.request<{ author?: { displayName?: string }; created: string; body?: unknown }>(
      "POST",
      `/rest/api/3/issue/${checkKey(key)}/comment`,
      { body: textToAdf(text) },
    );
    return { author: c.author?.displayName ?? "", created: c.created, text: adfToText(c.body) || text };
  }
}

function checkKey(key: string): string {
  if (!KEY.test(key)) throw new HttpError(400, `Ungültiger JIRA-Schlüssel „${key}“.`);
  return key;
}

function checkProjectKey(key: string): string {
  if (!PROJECT_KEY.test(key)) throw new HttpError(400, `Ungültiger JIRA-Projektschlüssel „${key}“.`);
  return key;
}

const jqlString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * The client for the stored credentials, made anew when they change. Without credentials: 409 `jira-missing`;
 * a project on another JIRA site than the stored one: 409 naming both.
 */
export class JiraAccess {
  private memo: { sig: string; client: JiraClient } | undefined;

  constructor(
    private read: () => JiraCredentials | null = () => jiraCredentials(),
    private fetcher: Fetch = fetch,
  ) {}

  client(project?: Project): JiraClient {
    const creds = this.read();
    if (!creds) throw new HttpError(409, "jira-missing");
    const sig = `${creds.site}\n${creds.email}\n${creds.token}`;
    if (this.memo?.sig !== sig) this.memo = { sig, client: new JiraClient(creds, this.fetcher) };
    const host = project?.jira.baseUrl?.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
    if (host && host !== creds.site.toLowerCase())
      throw new HttpError(409, `Der JIRA-Zugang gilt für ${creds.site}, das Projekt nutzt ${host}.`);
    return this.memo.client;
  }
}
