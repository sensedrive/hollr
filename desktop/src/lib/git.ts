// Git views for a space (same server ops as the iPhone app: `hollr gate fs` / `space`).
// Port of ios/Sources/Hollr/Views/Git/GitModels.swift + DiffViewer.swift (parsing, folds, graph layout, syntax).
import { gate } from "./api";
import { lang, t } from "./i18n";

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
export interface ChangesSummary { files: number; add: number; del: number }
export interface Graph { commits: GraphCommit[]; changes: ChangesSummary }
export interface CommitDetail { hash: string; author: string; email: string; at: number; subject: string; body: string; merge: boolean; files: FileChange[] }
export interface PullRequest { number: number; state: string; draft: boolean; checks?: string }
export interface Branch { name: string; subject: string; at: number; current: boolean; ahead: number; behind: number; pr?: PullRequest }
export interface Branches { local: Branch[]; remote: Branch[] }

const fs = <T>(server: string, body: Record<string, unknown>) => gate<T>(server, "fs", body);

export const spaces = (s: string) => gate<{ spaces: Space[] }>(s, "spaces").then((r) => r.spaces);
export const ls = (s: string, ws: string, path: string) => fs<{ entries: DirEntry[] }>(s, { op: "ls", ws, path }).then((r) => r.entries);
export const read = (s: string, ws: string, path: string) => fs<FileContent>(s, { op: "read", ws, path });
export const changes = (s: string, ws: string) => fs<Changes>(s, { op: "changes", ws });
export const diff = (s: string, ws: string, path: string, staged: boolean) =>
  fs<{ text: string }>(s, { op: "diff", ws, path, staged }).then((r) => r.text);
export const stage = (s: string, ws: string, path: string, on: boolean) => fs(s, { op: on ? "stage" : "unstage", ws, path });
export const graph = (s: string, ws: string, limit = 200) => fs<Graph>(s, { op: "graph", ws, limit });
export const commit = (s: string, ws: string, hash: string) => fs<CommitDetail>(s, { op: "commit", ws, hash });
export const commitDiff = (s: string, ws: string, hash: string, path?: string) =>
  fs<{ text: string }>(s, { op: "commitdiff", ws, hash, ...(path ? { path } : {}) }).then((r) => r.text);
export const branches = (s: string, ws: string) => fs<Branches>(s, { op: "branches", ws });
/** "@" completion in the composer: files of the space matching what was typed */
export const files = (s: string, ws: string, query: string, limit = 8) =>
  fs<{ files: string[] }>(s, { op: "files", ws, query, limit }).then((r) => r.files);
// review actions (Änderungen)
export const discard = (s: string, ws: string, path: string) => fs(s, { op: "discard", ws, path });
export const gitCommit = (s: string, ws: string, message: string, all: boolean) =>
  fs<{ hash: string }>(s, { op: "gitcommit", ws, message, all }).then((r) => r.hash);
export const push = (s: string, ws: string) => fs(s, { op: "push", ws });
export const openPr = (s: string, ws: string) => fs<{ url: string }>(s, { op: "pr", ws }).then((r) => r.url);

// ------------------------------------------------------------ small helpers

/** "1d", "41d", "3h", "2mo" like Moshi */
export function age(ms: number): string {
  const s = Math.max(0, Date.now() / 1000 - ms / 1000);
  if (s < 60) return t("jetzt");
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 60) return `${Math.floor(s / 86400)}d`;
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo`;
  return `${Math.floor(s / (86400 * 365))}y`;
}

/** "vor 3 Tagen" / "3 days ago" */
export function relative(ms: number): string {
  const s = (ms - Date.now()) / 1000;
  const f = new Intl.RelativeTimeFormat(lang(), { numeric: "auto" });
  const a = Math.abs(s);
  if (a < 60) return f.format(Math.round(s), "second");
  if (a < 3600) return f.format(Math.round(s / 60), "minute");
  if (a < 86400) return f.format(Math.round(s / 3600), "hour");
  if (a < 86400 * 30) return f.format(Math.round(s / 86400), "day");
  if (a < 86400 * 365) return f.format(Math.round(s / (86400 * 30)), "month");
  return f.format(Math.round(s / (86400 * 365)), "year");
}

export const dateTime = (ms: number) =>
  new Date(ms).toLocaleString(lang(), { dateStyle: "short", timeStyle: "short" });

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export const baseName = (p: string) => p.split("/").pop() ?? p;
export const dirName = (p: string) => p.split("/").slice(0, -1).join("/");
export const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
export const extOf = (p: string) => {
  const n = baseName(p).toLowerCase();
  if (n === "dockerfile" || n.startsWith("dockerfile.")) return "dockerfile";
  if (n.startsWith(".env")) return "env";
  return n.includes(".") ? (n.split(".").pop() ?? "") : "";
};

/** M / A / D / R badge text and color (untracked "?" shows as A). */
export const statusLabel = (s: string) => (s === "?" ? "A" : s);
export const statusColor = (s: string) =>
  ({ A: "var(--green)", "?": "var(--green)", D: "var(--red)", R: "var(--blue)" })[s] ?? "var(--purple)";

export const sumAdd = (files: FileChange[]) => files.reduce((n, f) => n + f.add, 0);
export const sumDel = (files: FileChange[]) => files.reduce((n, f) => n + f.del, 0);

/** `%D` decoration → chips: "HEAD -> main, origin/main, tag: v1" */
export interface Ref { name: string; kind: "head" | "local" | "remote" | "tag" }
export function parseRefs(refs?: string): Ref[] {
  if (!refs) return [];
  const out: Ref[] = [];
  for (const raw of refs.split(", ")) {
    const r = raw.trim();
    if (!r || r === "HEAD" || r.endsWith("/HEAD")) continue;
    if (r.startsWith("HEAD -> ")) out.push({ name: r.slice(8), kind: "head" });
    else if (r.startsWith("tag: ")) out.push({ name: r.slice(5), kind: "tag" });
    else if (r.includes("/")) out.push({ name: r, kind: "remote" });
    else out.push({ name: r, kind: "local" });
  }
  return out;
}

// ------------------------------------------------------------ file icons

/** Small letter/glyph badge + color per file type (FileIcon.symbol on iOS). */
export function fileIcon(name: string, dir: boolean): { glyph: string; color: string } {
  if (dir) return { glyph: "dir", color: "#6ca6f0" };
  const lower = name.toLowerCase();
  if (lower.startsWith(".env")) return { glyph: "≡", color: "#e5c07b" };
  if (lower === ".gitignore" || lower === ".gitattributes") return { glyph: "⑂", color: "#e0603a" };
  if (lower.startsWith("dockerfile") || lower === ".dockerignore") return { glyph: "D", color: "#3b9de0" };
  switch (extOf(name)) {
    case "ts": case "tsx": case "mts": case "cts": return { glyph: "TS", color: "#3b82d6" };
    case "js": case "jsx": case "mjs": case "cjs": return { glyph: "JS", color: "#e8c547" };
    case "json": case "jsonc": return { glyph: "{}", color: "#d9a441" };
    case "md": case "mdx": return { glyph: "M", color: "#5aa9f0" };
    case "yml": case "yaml": return { glyph: "Y", color: "#e05d5d" };
    case "toml": case "ini": case "conf": case "cfg": return { glyph: "⚙", color: "#8b95a5" };
    case "swift": return { glyph: "SW", color: "#f0743e" };
    case "py": return { glyph: "PY", color: "#4b8bbe" };
    case "rs": return { glyph: "RS", color: "#de7a4b" };
    case "go": return { glyph: "GO", color: "#4fc3d9" };
    case "sh": case "bash": case "zsh": return { glyph: "$", color: "#7cc36e" };
    case "css": case "scss": case "sass": return { glyph: "#", color: "#5aa9f0" };
    case "html": case "htm": case "vue": case "svelte": return { glyph: "</>", color: "#e5713e" };
    case "png": case "jpg": case "jpeg": case "gif": case "webp": case "svg": case "ico": case "heic": return { glyph: "▣", color: "#b48cf2" };
    case "pdf": return { glyph: "PDF", color: "#e05d5d" };
    case "lock": return { glyph: "🔒︎", color: "#8b95a5" };
    case "sql": case "prisma": return { glyph: "DB", color: "#5ed3c1" };
    case "txt": case "log": return { glyph: "≣", color: "#8b95a5" };
    default: return { glyph: "·", color: "#6c9bd2" };
  }
}

// ------------------------------------------------------------ diff

export interface DiffLine { id: number; kind: "context" | "added" | "removed" | "gap"; old?: number; new?: number; text: string }
export interface DiffFile { path: string; lines: DiffLine[]; add: number; del: number; binary?: boolean }

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | undefined;
  let oldN = 0;
  let newN = 0;
  let id = 0;
  const all = text.split("\n");
  if (all.at(-1) === "") all.pop();
  for (const line of all) {
    if (line.startsWith("diff --git ")) {
      cur = { path: line.split(" b/").pop() ?? line, lines: [], add: 0, del: 0 };
      files.push(cur);
      continue;
    }
    if (line.startsWith("+++ b/") && cur && !cur.lines.length) { cur.path = line.slice(6); continue; }
    if (line.startsWith("Binary files")) { if (cur) cur.binary = true; continue; }
    if (/^(--- |\+\+\+ |index |new file|deleted file|similarity|dissimilarity|rename |copy |old mode|new mode)/.test(line)) continue;
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
    if (!cur || line.startsWith("\\")) continue; // "\ No newline at end of file"
    const body = line.slice(1);
    if (line.startsWith("+")) { cur.lines.push({ id: id++, kind: "added", new: newN++, text: body }); cur.add++; }
    else if (line.startsWith("-")) { cur.lines.push({ id: id++, kind: "removed", old: oldN++, text: body }); cur.del++; }
    else cur.lines.push({ id: id++, kind: "context", old: oldN++, new: newN++, text: body });
  }
  return files.filter((f) => f.path || f.lines.length);
}

export type Block = { lines: DiffLine[] } | { fold: DiffLine[] };

/** Unchanged runs longer than 2×keep+1 collapse into a fold (no head context before the first change). */
export function fold(lines: DiffLine[], keep = 3): Block[] {
  const out: Block[] = [];
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

/** Side-by-side pairs: context on both sides, removed runs zipped with the following added run. */
export interface SplitRow { id: number; left?: DiffLine; right?: DiffLine; gap?: boolean }
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.kind === "gap") { rows.push({ id: l.id, gap: true }); i++; continue; }
    if (l.kind === "context") { rows.push({ id: l.id, left: l, right: l }); i++; continue; }
    const del: DiffLine[] = [];
    const add: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === "removed") del.push(lines[i++]);
    while (i < lines.length && lines[i].kind === "added") add.push(lines[i++]);
    for (let k = 0; k < Math.max(del.length, add.length); k++)
      rows.push({ id: (del[k] ?? add[k]).id, left: del[k], right: add[k] });
  }
  return rows;
}

// ------------------------------------------------------------ graph

/** One history row: lanes entering from the top, the node, lanes leaving at the bottom. */
export interface GraphRow {
  commit: GraphCommit;
  node: number;
  before: (string | null)[];
  after: (string | null)[];
  incoming: number[];
  outgoing: number[];
  width: number;
}

/** Classic lane assignment over topologically ordered commits (GraphLayout.rows). */
export function graphRows(commits: GraphCommit[], dirtyTop: boolean): GraphRow[] {
  const lanes: (string | null)[] = dirtyTop && commits[0] ? [commits[0].hash] : [];
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
    rows.push({
      commit: c, node, before, after: [...lanes],
      incoming: matches.filter((i) => i !== node), outgoing,
      width: Math.max(before.length, lanes.length, node + 1),
    });
  }
  return rows;
}

/** Lane palette (GitStyle.lanes): theme colors, so light themes stay readable. */
export const LANE_COLORS = ["var(--purple)", "var(--orange)", "var(--pink)", "var(--cyan)", "var(--blue)", "var(--green)", "var(--yellow)", "var(--red)"];
export const laneColor = (i: number) => LANE_COLORS[i % LANE_COLORS.length];

// ------------------------------------------------------------ syntax (tiny, per line)

const KEYWORDS = new Set(("import from export default const let var function return if else for while do class struct enum interface type func async await new case switch break continue true false null nil undefined self this def end in of as public private protected static throw throws try catch guard extends implements package fn pub use mod impl match where yield lambda None True False elif with pass raise and or not is readonly override").split(" "));
const HASH_COMMENTS = new Set(["py", "sh", "bash", "zsh", "yml", "yaml", "toml", "rb", "env", "conf", "dockerfile"]);
const PUNCT = new Set([..."{}()[];,"]);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One line → HTML with `hl-*` spans (keyword, string, comment, number, type, punctuation). */
export function highlight(line: string, ext: string): string {
  const hash = HASH_COMMENTS.has(ext);
  const trimmed = line.trimStart();
  if (!hash && (trimmed.startsWith("/*") || trimmed.startsWith("* ") || trimmed === "*" || trimmed.startsWith("*/") || trimmed.startsWith("<!--")))
    return `<span class="hl-c">${esc(line)}</span>`;
  let out = "";
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if ((c === "/" && line[i + 1] === "/") || (hash && c === "#")) return out + `<span class="hl-c">${esc(line.slice(i))}</span>`;
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < line.length && line[j] !== c) j += line[j] === "\\" ? 2 : 1;
      out += `<span class="hl-s">${esc(line.slice(i, j + 1))}</span>`;
      i = j + 1;
      continue;
    }
    const word = line.slice(i).match(/^[A-Za-z_$][\w$]*|^\d[\w.]*/)?.[0];
    if (word) {
      const cls = KEYWORDS.has(word) ? "k" : /^\d/.test(word) ? "n" : /^[A-Z]/.test(word) && ext !== "md" ? "t" : "";
      out += cls ? `<span class="hl-${cls}">${esc(word)}</span>` : esc(word);
      i += word.length;
      continue;
    }
    out += PUNCT.has(c) ? `<span class="hl-p">${esc(c)}</span>` : esc(c);
    i++;
  }
  return out;
}

// ------------------------------------------------------------ prefs (per device)

export function pref(key: string, fallback: boolean): boolean {
  try { const v = localStorage.getItem(`hollr.git.${key}`); return v === null ? fallback : v === "1"; } catch { return fallback; }
}
export function setPref(key: string, v: boolean) {
  try { localStorage.setItem(`hollr.git.${key}`, v ? "1" : "0"); } catch {}
}
