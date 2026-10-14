// Spaces = herdr workspaces with repo / worktree info (server: `hollr gate spaces` / `space`).
import { gate } from "$lib/api";
import type { Space } from "$lib/git";

/** the fields the server sends beyond `Space` in git.ts */
export type FullSpace = Space & {
  number?: number;
  focused?: boolean;
  status?: string;
  paneCount?: number;
  git?: Space["git"] & { lastCommit?: { hash: string; subject: string; at: number } };
};

/** repo main checkout first, its worktrees nested below; other workspaces standalone */
export function groupSpaces(spaces: FullSpace[]): { key: string; spaces: FullSpace[] }[] {
  const groups: { key: string; spaces: FullSpace[] }[] = [];
  for (const s of spaces) {
    if (s.isWorktree) continue;
    const worktrees = spaces.filter((w) => w.isWorktree && w.repo && w.repo === s.repo);
    groups.push({ key: s.id, spaces: [s, ...worktrees] });
  }
  const placed = new Set(groups.flatMap((g) => g.spaces.map((s) => s.id)));
  for (const o of spaces) if (!placed.has(o.id)) groups.push({ key: o.id, spaces: [o] });
  return groups;
}

export interface CloseInfo {
  ws: string;
  label: string;
  root: string;
  isWorktree: boolean;
  git: boolean;
  branch?: string;
  changed: number;
  add: number;
  del: number;
  unpushed: number;
  remoteBranch: boolean;
  defaultBranch: boolean;
  agents: number;
  linkedWorktrees?: number;
  canDeleteFolder: boolean;
}

export interface SpaceRequest {
  op: "create" | "worktree" | "close" | "info";
  cwd?: string;
  label?: string;
  ws?: string;
  branch?: string;
  base?: string;
  agent?: string;
  removeWorktree?: boolean;
  force?: boolean;
  deleteBranch?: boolean;
  deleteRemote?: boolean;
  deleteFolder?: boolean;
}

export const space = (server: string, req: SpaceRequest) => gate<{ ws?: string; pane?: string }>(server, "space", req);
export const closeInfo = (server: string, ws: string) => gate<CloseInfo>(server, "space", { op: "info", ws });

export const folderOf = (root: string) => root.split("/").filter(Boolean).pop() ?? root;
