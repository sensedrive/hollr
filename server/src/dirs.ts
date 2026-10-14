/**
 * Folder browser for "Neuer Space → Ordner": subfolders of a path inside the home directory,
 * git repos marked (with their branch). Read-only, never outside $HOME.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";

export interface DirEntry {
  name: string;
  /** "~/…" form, ready for the folder field */
  path: string;
  repo: boolean;
  branch?: string;
}

const SKIP = new Set([
  "node_modules",
  "Library",
  "Applications",
  "Pictures",
  "Music",
  "Movies",
  "Public",
]);
const PLACES = [
  "projects",
  "Projects",
  "code",
  "Code",
  "dev",
  "src",
  "Developer",
  "work",
  "git",
  "repos",
  "PhpstormProjects",
  "WebstormProjects",
  "IdeaProjects",
  "PycharmProjects",
  "Documents/GitHub",
];

const tilde = (abs: string, home: string) => (abs === home ? "~" : `~/${relative(home, abs)}`);

function branchOf(dir: string): string | undefined {
  try {
    let gitDir = join(dir, ".git");
    if (statSync(gitDir).isFile()) {
      // worktree: ".git" is a file "gitdir: …"
      gitDir = readFileSync(gitDir, "utf8")
        .replace(/^gitdir:\s*/, "")
        .trim();
    }
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    return head.startsWith("ref: refs/heads/") ? head.slice(16) : head.slice(0, 7);
  } catch {
    return undefined;
  }
}

export function listDirs(path = "~") {
  const home = realpathSync(homedir());
  const wanted =
    path.trim() === "" || path.trim() === "~" ? home : path.trim().replace(/^~(?=\/|$)/, home);
  let dir: string;
  try {
    dir = realpathSync(wanted);
  } catch {
    throw new Error("not_found");
  }
  if (dir !== home && !dir.startsWith(home + sep)) throw new Error("outside_home");
  if (!statSync(dir).isDirectory()) throw new Error("not_a_folder");

  const dirs: DirEntry[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (!isDir) continue;
    const repo = existsSync(join(full, ".git"));
    dirs.push({
      name: e.name,
      path: tilde(full, home),
      repo,
      ...(repo ? { branch: branchOf(full) } : {}),
    });
    if (dirs.length >= 500) break;
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const atHome = dir === home;
  return {
    path: tilde(dir, home),
    parent: atHome ? null : tilde(join(dir, ".."), home),
    repo: existsSync(join(dir, ".git")),
    dirs,
    // where projects usually live (only at ~, only what exists)
    places: atHome
      ? PLACES.filter((p) => {
          try {
            return statSync(join(home, p)).isDirectory();
          } catch {
            return false;
          }
        }).map((p) => `~/${p}`)
      : [],
  };
}
