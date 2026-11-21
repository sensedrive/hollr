/**
 * The skills an agent in `cwd` can call (the composer suggests them after "/"): the user's own
 * (~/.claude/skills, ~/.agents/skills, ~/.omp/agent/skills) and the project's (.claude/skills, .agents/skills
 * from `cwd` up to its repo root). Name and description come from each SKILL.md's frontmatter.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Skill {
  name: string;
  description: string;
  /** "user" or "project" */
  scope: "user" | "project";
}

function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const out: Record<string, string> = {};
  for (const line of m?.[1]?.split("\n") ?? []) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv?.[1]) out[kv[1]] = (kv[2] ?? "").replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

function readDir(dir: string, scope: Skill["scope"], into: Map<string, Skill>) {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const file = join(dir, n, "SKILL.md");
    if (!existsSync(file)) continue;
    try {
      const fm = frontmatter(readFileSync(file, "utf8").slice(0, 4000));
      // user-invoked only (disable-model-invocation) still counts: the user calls it here
      const name = fm.name || n;
      if (!into.has(name)) into.set(name, { name, description: fm.description ?? "", scope });
    } catch {}
  }
}

/** project skills win over user skills of the same name; sorted by name */
export function listSkills(cwd: string, home = Bun.env.HOME ?? homedir()): Skill[] {
  const found = new Map<string, Skill>();
  // the project: from cwd up to the folder with .git (or home)
  let dir = cwd;
  for (let i = 0; i < 12 && dir && dir !== home && dir !== "/"; i++) {
    readDir(join(dir, ".claude", "skills"), "project", found);
    readDir(join(dir, ".agents", "skills"), "project", found);
    if (existsSync(join(dir, ".git"))) break;
    dir = dirname(dir);
  }
  for (const d of [
    join(home, ".claude", "skills"),
    join(home, ".agents", "skills"),
    join(home, ".omp", "agent", "skills"),
  ])
    readDir(d, "user", found);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
