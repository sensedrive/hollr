/** GitHub through the gh CLI (its login on this computer); every call names the repo. */
import { firstLine, HttpError, run } from "./env";

export interface GhLabel {
  name: string;
  color?: string;
}

export interface GhIssue {
  number: number;
  title: string;
  body: string;
  labels: GhLabel[];
  url: string;
  state?: string;
  updatedAt?: string;
  closedAt?: string;
}

export interface GhComment {
  author?: { login?: string };
  createdAt: string;
  body: string;
}

export interface GhIssueDetail extends GhIssue {
  state: string;
  comments: GhComment[];
}

async function gh(args: string[], stdin?: string): Promise<string> {
  const r = await run(["gh", ...args], { stdin, timeoutMs: 30_000 });
  if (!r.ok) throw new HttpError(502, `gh: ${firstLine(r.err)}`);
  return r.out;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export const listOpen = async (slug: string): Promise<GhIssue[]> =>
  JSON.parse(
    await gh([
      "issue", "list", "--repo", slug, "--state", "open", "--limit", "500",
      "--json", "number,title,labels,body,updatedAt,url",
    ]),
  );

export const listClosedRecent = async (slug: string): Promise<GhIssue[]> =>
  JSON.parse(
    await gh([
      "issue", "list", "--repo", slug, "--state", "closed", "--limit", "50",
      "--search", `closed:>=${isoDay(new Date(Date.now() - 14 * 86_400_000))}`,
      "--json", "number,title,labels,body,closedAt,url",
    ]),
  );

export const listLabels = async (slug: string): Promise<GhLabel[]> =>
  JSON.parse(await gh(["label", "list", "--repo", slug, "--limit", "200", "--json", "name,color"]));

export const view = async (slug: string, n: number): Promise<GhIssueDetail> =>
  JSON.parse(
    await gh(["issue", "view", String(n), "--repo", slug, "--json", "number,title,state,body,labels,url,comments"]),
  );

export async function edit(slug: string, n: number, add: string[], remove: string[]): Promise<void> {
  if (!add.length && !remove.length) return;
  const args = ["issue", "edit", String(n), "--repo", slug];
  for (const l of add) args.push("--add-label", l);
  for (const l of remove) args.push("--remove-label", l);
  await gh(args);
}

export async function close(slug: string, n: number): Promise<void> {
  await gh(["issue", "close", String(n), "--repo", slug]);
}

export async function reopen(slug: string, n: number): Promise<void> {
  await gh(["issue", "reopen", String(n), "--repo", slug]);
}

export async function comment(slug: string, n: number, body: string): Promise<void> {
  await gh(["issue", "comment", String(n), "--repo", slug, "--body-file", "-"], body);
}

/** The new issue's number (read from the URL gh prints). */
export async function create(slug: string, title: string, body: string, labels: string[]): Promise<number> {
  const args = ["issue", "create", "--repo", slug, "--title", title, "--body-file", "-"];
  for (const l of labels) args.push("--label", l);
  const out = await gh(args, body);
  const n = Number(out.match(/\/issues\/(\d+)/)?.[1]);
  if (!n) throw new HttpError(502, `gh: keine Issue-Nummer in „${out.trim()}“`);
  return n;
}
