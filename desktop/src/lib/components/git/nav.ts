// Shared bits for the git panel: what the detail pane shows, and list keyboard navigation.

export type Tab = "files" | "changes" | "history" | "branches";

export type Detail =
  | { k: "file"; path: string }
  /** working-tree diff (path + staged) or commit diff (hash, optional path) */
  | { k: "diff"; title: string; path?: string; staged?: boolean; hash?: string }
  | { k: "commit"; hash: string; subject: string };

export const detailKey = (d?: Detail) =>
  !d ? "" : d.k === "file" ? `file:${d.path}` : d.k === "commit" ? `commit:${d.hash}`
    : d.hash ? `cdiff:${d.hash}:${d.path ?? ""}` : `diff:${d.staged ? 1 : 0}:${d.path}`;

/** ↑/↓/Home/End move, Enter (or →) opens. Returns true when the key was handled. */
export function navKey(e: KeyboardEvent, count: number, sel: number, set: (i: number) => void, open: (i: number) => void): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey || !count) return false;
  const tag = (e.target as HTMLElement | null)?.tagName;
  const typing = tag === "INPUT" || tag === "TEXTAREA";
  if (typing && !["ArrowDown", "ArrowUp", "Enter"].includes(e.key)) return false;
  let next = sel;
  switch (e.key) {
    case "ArrowDown": case "j": next = Math.min(count - 1, sel + 1); break;
    case "ArrowUp": case "k": next = Math.max(0, sel - 1); break;
    case "Home": next = 0; break;
    case "End": next = count - 1; break;
    case "Enter": case "ArrowRight":
      e.preventDefault();
      if (sel >= 0 && sel < count) open(sel);
      return true;
    default: return false;
  }
  e.preventDefault();
  set(next);
  return true;
}

/** Keeps the selected row (data-i) visible. */
export function reveal(root: HTMLElement | undefined, i: number) {
  root?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
}
