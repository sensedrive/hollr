// The `links` gate per pane (server/src/links.ts): which repo and JIRA project a session's ticket links point to.
import { getContext, setContext } from "svelte";
import { gate } from "./api";
import { NO_LINKS, parseLinkInfo, type LinkInfo } from "./issueLinks";

const TTL = 10 * 60_000;
/** per "server|pane": the answer and when it was asked; older servers without the gate count as no links */
const cache = new Map<string, { at: number; info: Promise<LinkInfo> }>();

export function paneLinks(server: string, pane: string): Promise<LinkInfo> {
  const key = `${server}|${pane}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.info;
  const info = gate<unknown>(server, "links", { pane }).then(parseLinkInfo, () => NO_LINKS);
  cache.set(key, { at: Date.now(), info });
  return info;
}

const CONTEXT = Symbol("issueLinks");

/** The session view hands its pane's links to every Markdown answer below it. */
export function provideIssueLinks(get: () => LinkInfo | undefined): void {
  setContext(CONTEXT, get);
}

export function issueLinksContext(): (() => LinkInfo | undefined) | undefined {
  return getContext(CONTEXT);
}
