/**
 * `hollr gate file [<pane>]`, stdin {"path":"…"}: one file or folder the agent mentioned, for the app's preview.
 * `~/…`, absolute, or relative to the pane's folder (its foreground cwd, then the space root). Only inside the
 * home directory or the temp folders, never key or credential files (DENY_* below). A paired device can already
 * open its own shell on the server, so this reads nothing it couldn't – the limits keep a stray click harmless.
 */
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  type Stats,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type Exec, execHerdr } from "./herdr";
import { listSpaces } from "./spaces";

/** text beyond this is cut (the app shows "gekürzt") */
export const TEXT_LIMIT = 1_000_000;
/** images up to this size come along as base64 */
export const IMAGE_LIMIT = 15 * 1024 * 1024;
/** entries a folder listing shows at most */
export const DIR_LIMIT = 500;

export type FileKind = "image" | "text" | "binary" | "dir";

export interface FileEntry {
  name: string;
  dir: boolean;
  size: number;
}

export interface FileResult {
  /** the real absolute path (symlinks resolved) */
  path: string;
  name: string;
  size: number;
  /** epoch ms */
  mtime: number;
  kind: FileKind;
  mime: string;
  text?: string;
  /** base64, images only */
  data?: string;
  /** text cut at TEXT_LIMIT, an image over IMAGE_LIMIT (no data), a folder with more than DIR_LIMIT entries */
  truncated: boolean;
  /** relative to the pane's space root when inside it ("" = the root itself) – the app's git panel can open it */
  inSpace?: string;
  /** dir only: folders first, then files, by name */
  entries?: FileEntry[];
}

/** Error codes the app turns into readable text. */
export type FileError = "not_found" | "outside" | "secret" | "unreadable";

export class FileRefused extends Error {
  constructor(readonly code: FileError) {
    super(code);
  }
}

const IMAGES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".heic": "image/heic",
};
const OTHER_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".md": "text/markdown",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".csv": "text/csv",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

// Home-relative folders (and files) that hold keys, tokens or the server's own pairing state.
const DENY_DIRS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".password-store",
  ".config/hollr",
  ".config/gh",
  ".config/op",
  ".config/1Password",
  ".local/share/keyrings",
  "Library/Keychains",
];
// File names anywhere: private keys, certificates with keys, token stores, .env files (not their templates).
const DENY_NAMES = [
  /^id_[a-z0-9_-]+$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk)$/i,
  /^\.(netrc|git-credentials|npmrc|pypirc|pgpass)$/,
  /^\.?credentials(\.json)?$/i,
  /^auth\.json$/i,
  /^agent\.db(-wal|-shm)?$/,
  /^\.env(?!\.(example|sample|template|dist)$)(\..+)?$/,
];

export interface FileContext {
  /** folder relative paths start from (the pane's foreground cwd) */
  cwd?: string;
  /** the pane's space root: second guess for relative paths, and `inSpace` */
  root?: string;
  home?: string;
  /** allowed besides home (tests inject; default /tmp and the per-user temp folder) */
  tmp?: string[];
}

/** realpath; a path that doesn't exist (yet) gets its nearest existing parent resolved (/tmp → /private/tmp). */
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(real(parent), basename(p));
  }
}

const under = (p: string, dir: string) =>
  p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** `file://` URLs, `~`, absolute, else relative to `base` – lexical, nothing is checked yet. */
export function expandPath(raw: string, base: string, home: string): string {
  let p = raw.trim();
  if (/^file:\/\//i.test(p)) {
    try {
      p = decodeURIComponent(new URL(p).pathname);
    } catch {
      p = p.slice(7);
    }
  }
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return isAbsolute(p) ? resolve(p) : resolve(base, p);
}

/** Why a (real) path may not be read, or undefined when it may. */
export function refusal(path: string, home: string, tmp: string[]): FileError | undefined {
  const inHome = under(path, home);
  if (!inHome && !tmp.some((t) => under(path, t))) return "outside";
  if (inHome) {
    const rel = relative(home, path);
    if (DENY_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`))) return "secret";
  }
  if (DENY_NAMES.some((re) => re.test(basename(path)))) return "secret";
  return undefined;
}

/** Resolves, checks and reads one path. Throws FileRefused. */
export function readPath(raw: string, ctx: FileContext = {}): FileResult {
  if (!raw.trim()) throw new FileRefused("not_found");
  const home = real(ctx.home ?? homedir());
  const tmp = (ctx.tmp ?? ["/tmp", tmpdir()]).map(real);
  const cwd = ctx.cwd || home;
  // a relative path from a tool card may be space-relative while the agent sits in a subfolder
  const candidates = [expandPath(raw, cwd, home)];
  if (ctx.root && ctx.root !== cwd) candidates.push(expandPath(raw, ctx.root, home));
  const found = candidates.find((c) => existsSync(c));
  // refuse lexically first, so a missing file outside home answers "outside", not "not_found"
  const lexical = found ?? candidates[0] ?? "";
  const why = refusal(real(lexical), home, tmp);
  if (why) throw new FileRefused(why);
  if (!found) throw new FileRefused("not_found");
  const path = realpathSync(found);
  // symlinks can point elsewhere: check the real path again
  const again = refusal(path, home, tmp);
  if (again) throw new FileRefused(again);

  let st: Stats;
  try {
    st = statSync(path);
  } catch {
    throw new FileRefused("unreadable");
  }
  const root = ctx.root ? real(ctx.root) : undefined;
  const base = {
    path,
    name: basename(path) || path,
    size: st.isFile() ? st.size : 0,
    mtime: Math.round(st.mtimeMs),
    ...(root && under(path, root) ? { inSpace: relative(root, path) } : {}),
  };
  try {
    if (st.isDirectory()) return { ...base, ...listing(path) };
    const ext = extname(path).toLowerCase();
    const image = IMAGES[ext];
    if (image) {
      const big = st.size > IMAGE_LIMIT;
      return {
        ...base,
        kind: "image",
        mime: image,
        truncated: big,
        ...(big ? {} : { data: readFileSync(path).toString("base64") }),
      };
    }
    const buf = readHead(path, Math.min(st.size, TEXT_LIMIT));
    const mime = OTHER_MIME[ext] ?? "";
    if (
      buf.subarray(0, 8000).includes(0) ||
      (mime.startsWith("application/") && mime !== "application/json")
    )
      return {
        ...base,
        kind: "binary",
        mime: mime || "application/octet-stream",
        truncated: false,
      };
    return {
      ...base,
      kind: "text",
      mime: mime || "text/plain",
      text: buf.toString("utf8"),
      truncated: st.size > buf.length,
    };
  } catch (err) {
    if (err instanceof FileRefused) throw err;
    throw new FileRefused("unreadable");
  }
}

/** The first `n` bytes without loading a huge file whole. */
function readHead(path: string, n: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(n);
    return buf.subarray(0, readSync(fd, buf, 0, n, 0));
  } finally {
    closeSync(fd);
  }
}

function listing(dir: string): Pick<FileResult, "kind" | "mime" | "truncated" | "entries"> {
  const all = readdirSync(dir, { withFileTypes: true });
  const entries = all
    .map((e) => {
      const full = join(dir, e.name);
      let isDir = e.isDirectory();
      let size = 0;
      try {
        const st = statSync(full);
        isDir = st.isDirectory();
        size = isDir ? 0 : st.size;
      } catch {}
      return { name: e.name, dir: isDir, size };
    })
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return {
    kind: "dir",
    mime: "inode/directory",
    truncated: entries.length > DIR_LIMIT,
    entries: entries.slice(0, DIR_LIMIT),
  };
}

/** The pane's folder and its space root from herdr (missing pane: home). */
export async function paneContext(pane: string, exec: Exec = execHerdr): Promise<FileContext> {
  if (!pane) return {};
  const out = (await exec(["pane", "get", pane])) as {
    pane?: { foreground_cwd?: string; cwd?: string; workspace_id?: string };
  };
  const p = out?.pane;
  const cwd = [p?.foreground_cwd, p?.cwd].find((c) => c && existsSync(c));
  let root: string | undefined;
  try {
    root = (await listSpaces(exec)).find((s) => s.id === p?.workspace_id)?.root || undefined;
  } catch {}
  return { cwd, root };
}
