// Git views for a space (same server ops as the iPhone app: `hollr gate fs` / `space`).
import { gate } from "./api";

export interface Space {
  id: string;
  label: string;
  root: string;
  repo?: string;
  isWorktree: boolean;
  git?: { branch: string; ahead: number; behind: number; dirty: number };
}
export interface DirEntry { name: string; dir: boolean; size: number; mtime?: number }
export interface FileContent { path: string; size: number; binary: boolean; truncated: boolean; text: string }
export interface FileChange { path: string; status: string; add: number; del: number }
export interface Changes { branch: string; staged: FileChange[]; unstaged: FileChange[] }
export interface GraphCommit { hash: string; parents: string[]; subject: string; author: string; at: number; refs?: string }
export interface Graph { commits: GraphCommit[]; changes: { files: number; add: number; del: number } }
export interface CommitDetail { hash: string; author: string; email: string; at: number; subject: string; body: string; merge: boolean; files: FileChange[] }
export interface Branch { name: string; subject: string; at: number; current: boolean; ahead: number; behind: number;
  pr?: { number: number; state: string; draft: boolean; checks?: string } }
export interface Branches { local: Branch[]; remote: Branch[] }

const fs = <T>(server: string, body: Record<string, unknown>) => gate<T>(server, "fs", body);

export const spaces = (s: string) => gate<{ spaces: Space[] }>(s, "spaces").then((r) => r.spaces);
export const ls = (s: string, ws: string, path: string) => fs<{ entries: DirEntry[] }>(s, { op: "ls", ws, path }).then((r) => r.entries);
export const read = (s: string, ws: string, path: string) => fs<FileContent>(s, { op: "read", ws, path });
export const changes = (s: string, ws: string) => fs<Changes>(s, { op: "changes", ws });
export const diff = (s: string, ws: string, path: string, staged: boolean) =>
  fs<{ text: string }>(s, { op: "diff", ws, path, staged }).then((r) => r.text);
export const stage = (s: string, ws: string, path: string, on: boolean) => fs(s, { op: on ? "stage" : "unstage", ws, path });
export const graph = (s: string, ws: string) => fs<Graph>(s, { op: "graph", ws, limit: 200 });
export const commit = (s: string, ws: string, hash: string) => fs<CommitDetail>(s, { op: "commit", ws, hash });
export const commitDiff = (s: string, ws: string, hash: string, path?: string) =>
  fs<{ text: string }>(s, { op: "commitdiff", ws, hash, ...(path ? { path } : {}) }).then((r) => r.text);
export const branches = (s: string, ws: string) => fs<Branches>(s, { op: "branches", ws });

export function age(ms: number): string {
  const s = Math.max(0, Date.now() / 1000 - ms / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 60) return `${Math.floor(s / 86400)}d`;
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo`;
  return `${Math.floor(s / (86400 * 365))}y`;
}

// ------------------------------------------------------------ diff

export interface DiffLine { id: number; kind: "context" | "added" | "removed" | "gap"; old?: number; new?: number; text: string }
export interface DiffFile { path: string; lines: DiffLine[]; add: number; del: number }

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | undefined;
  let oldN = 0;
  let newN = 0;
  let id = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = { path: line.split(" b/").pop() ?? line, lines: [], add: 0, del: 0 };
      files.push(cur);
      continue;
    }
    if (/^(--- |\+\+\+ |index |new file|deleted file|similarity|rename |old mode|new mode|Binary files)/.test(line)) continue;
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      if (!cur) { cur = { path: "", lines: [], add: 0, del: 0 }; files.push(cur); }
      const n = Number(hunk[2]);
      const last = cur.lines.at(-1);
      if (last && (last.new ?? last.old ?? 0) + 1 < n) cur.lines.push({ id: id++, kind: "gap", text: "…" });
      oldN = Number(hunk[1]);
      newN = n;
      continue;
    }
    if (!cur || line.startsWith("\\")) continue;
    const body = line.slice(1);
    if (line.startsWith("+")) { cur.lines.push({ id: id++, kind: "added", new: newN++, text: body }); cur.add++; }
    else if (line.startsWith("-")) { cur.lines.push({ id: id++, kind: "removed", old: oldN++, text: body }); cur.del++; }
    else if (line.length) cur.lines.push({ id: id++, kind: "context", old: oldN++, new: newN++, text: body });
  }
  return files;
}

/** Splits lines into visible runs and folded unchanged runs (keep 3 lines around changes). */
export function fold(lines: DiffLine[], keep = 3): ({ lines: DiffLine[] } | { fold: DiffLine[] })[] {
  const out: ({ lines: DiffLine[] } | { fold: DiffLine[] })[] = [];
  let buf: DiffLine[] = [];
  let ctx: DiffLine[] = [];
  let seenChange = false;
  const flush = (isEnd: boolean) => {
    const head = seenChange ? keep : 0;
    const tail = isEnd ? 0 : keep;
    if (ctx.length > head + tail + 1) {
      buf.push(...ctx.slice(0, head));
      if (buf.length) out.push({ lines: buf });
      out.push({ fold: ctx.slice(head, ctx.length - tail) });
      buf = ctx.slice(ctx.length - tail);
    } else buf.push(...ctx);
    ctx = [];
  };
  for (const l of lines) {
    if (l.kind === "context") ctx.push(l);
    else { flush(false); buf.push(l); seenChange = true; }
  }
  flush(true);
  if (buf.length) out.push({ lines: buf });
  return out;
}

// ------------------------------------------------------------ graph

export interface GraphRow { commit: GraphCommit; node: number; before: (string | null)[]; after: (string | null)[]; outgoing: number[]; width: number }

export function graphRows(commits: GraphCommit[], dirtyTop: boolean): GraphRow[] {
  let lanes: (string | null)[] = dirtyTop && commits[0] ? [commits[0].hash] : [];
  const rows: GraphRow[] = [];
  const free = (except?: number) => {
    const i = lanes.findIndex((l, k) => l === null && k !== except);
    if (i !== -1) return i;
    lanes.push(null);
    return lanes.length - 1;
  };
  for (const c of commits) {
    const matches = lanes.flatMap((l, i) => (l === c.hash ? [i] : []));
    const node = matches[0] ?? free();
    const before = [...lanes];
    for (const i of matches) if (i !== node) lanes[i] = null;
    const outgoing: number[] = [];
    const [first, ...rest] = c.parents;
    if (first !== undefined) {
      const existing = lanes.findIndex((l, i) => l === first && i !== node);
      if (existing !== -1 && existing < node) { lanes[node] = null; outgoing.push(existing); }
      else { lanes[node] = first; outgoing.push(node); }
      for (const p of rest) {
        const k = lanes.indexOf(p);
        if (k !== -1) outgoing.push(k);
        else { const f = free(node); lanes[f] = p; outgoing.push(f); }
      }
    } else lanes[node] = null;
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    rows.push({ commit: c, node, before, after: [...lanes], outgoing, width: Math.max(before.length, lanes.length, node + 1) });
  }
  return rows;
}

export const LANE_COLORS = ["#b48cf2", "#e39a4c", "#e05ca8", "#5ed3c1", "#8b6cf0", "#5aa9f0", "#8bd17c", "#f07272"];

// ------------------------------------------------------------ syntax (tiny, per line)

const KEYWORDS = new Set(("import from export default const let var function return if else for while do class struct enum interface type func async await new case switch break continue true false null nil undefined self this def end in of as public private protected static throw throws try catch guard extends implements package fn pub use mod impl match where yield None True False elif with pass raise and or not is readonly override").split(" "));

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function highlight(line: string, ext: string): string {
  const hash = ["py", "sh", "bash", "zsh", "yml", "yaml", "toml", "rb", "env", "conf"].includes(ext);
  let out = "";
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if ((c === "/" && line[i + 1] === "/") || (hash && c === "#")) return out + `<span class="c">${esc(line.slice(i))}</span>`;
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < line.length && line[j] !== c) j += line[j] === "\\" ? 2 : 1;
      out += `<span class="s">${esc(line.slice(i, j + 1))}</span>`;
      i = j + 1;
      continue;
    }
    const word = line.slice(i).match(/^[A-Za-z_$][\w$]*|^\d[\w.]*/)?.[0];
    if (word) {
      const cls = KEYWORDS.has(word) ? "k" : /^\d/.test(word) ? "n" : /^[A-Z]/.test(word) ? "t" : "";
      out += cls ? `<span class="${cls}">${esc(word)}</span>` : esc(word);
      i += word.length;
      continue;
    }
    out += esc(c);
    i++;
  }
  return out;
}

export const extOf = (p: string) => (p.split(".").pop() ?? "").toLowerCase();
