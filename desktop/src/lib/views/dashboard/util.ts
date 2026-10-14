// Small helpers shared by the dashboard, agent list and spaces views (ported from the iOS models).
import type { Pane } from "$lib/api";
import { lang } from "$lib/i18n";
import { type PaneRef, tabName } from "$lib/store.svelte";

/** omp, Claude, Codex … – "Shell" for a plain terminal */
export function agentName(pane: Pane): string {
  switch (pane.agent) {
    case "omp": return "omp";
    case "claude": return "Claude";
    case "codex": return "Codex";
    case undefined: case null: case "": return "Shell";
    default: return pane.agent;
  }
}

/** short badge text + color for an agent kind */
export function badge(agent?: string): { short: string; color: string } {
  switch (agent) {
    case "omp": return { short: "omp", color: "var(--green)" };
    case "claude": return { short: "CC", color: "#d97857" };
    case "codex": return { short: "CX", color: "var(--accent)" };
    case undefined: case null: case "": return { short: "$_", color: "var(--dim)" };
    default: return { short: agent.slice(0, 3), color: "var(--accent)" };
  }
}

export function statusColor(status: string): string {
  switch (status) {
    case "idle": case "done": return "var(--green)";
    case "working": return "var(--purple)";
    case "blocked": return "var(--orange)";
    default: return "var(--dim)";
  }
}

/** Heeler-style ordering: needs-you first, then busy, then the rest */
export function statusRank(r: PaneRef): number {
  switch (r.pane.status) {
    case "blocked": return 0;
    case "done": return 1;
    case "working": return 2;
    case "idle": return 3;
    default: return r.pane.agent ? 4 : 5;
  }
}

export function sortRefs(refs: PaneRef[]): PaneRef[] {
  return [...refs].sort(
    (a, b) =>
      statusRank(a) - statusRank(b) ||
      a.server.label.localeCompare(b.server.label) ||
      a.workspace.number - b.workspace.number ||
      a.tab.number - b.tab.number ||
      a.pane.pane.localeCompare(b.pane.pane),
  );
}

/** tab name, or the workspace name for herdr's numbered tabs */
export const refTitle = (r: PaneRef) => tabName(r.tab.label, r.workspace.label);

export const folderOf = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

/** Drops box-drawing frames, powerline glyphs and empty lines so a terminal screen reads well small. */
export function cleanScreen(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      let l = line.replace(/[│┃╭╮╰╯]/g, "");
      l = [...l].filter((ch) => {
        const c = ch.codePointAt(0) ?? 0;
        return !((c >= 0xe000 && c <= 0xf8ff) || c >= 0xf0000);
      }).join("");
      return l.replace(/\s+$/, "");
    })
    .filter((l) => {
      const s = l.trim();
      return s && ![...s].every((c) => "─━═-".includes(c));
    })
    .join("\n");
}

/** "vor 3 Std." / "3 hr. ago" */
export function relTime(ms: number): string {
  const diff = (ms - Date.now()) / 1000;
  const f = new Intl.RelativeTimeFormat(lang(), { numeric: "auto", style: "short" });
  const abs = Math.abs(diff);
  if (abs < 60) return f.format(Math.round(diff), "second");
  if (abs < 3600) return f.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return f.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 30) return f.format(Math.round(diff / 86400), "day");
  if (abs < 86400 * 365) return f.format(Math.round(diff / (86400 * 30)), "month");
  return f.format(Math.round(diff / (86400 * 365)), "year");
}

/** 200000 → "200k", 1000000 → "1M" */
export const ctxLabel = (n?: number) =>
  !n ? "" : n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : `${Math.round(n / 1000)}k`;

/** Arrow keys move focus between `[data-nav]` elements inside the node (lists and card grids). */
export function arrowNav(node: HTMLElement) {
  const onKey = (e: KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const target = e.target as HTMLElement;
    if (target.matches("input, textarea, select")) return;
    const items = [...node.querySelectorAll<HTMLElement>("[data-nav]")];
    const i = items.indexOf(target.closest("[data-nav]") as HTMLElement);
    if (i === -1) return;
    let next = i;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      // in a grid jump to the item below/above (same column), in a list to the next one
      const r = items[i]!.getBoundingClientRect();
      const down = e.key === "ArrowDown";
      const below = items
        .map((el, k) => ({ k, r: el.getBoundingClientRect() }))
        .filter(({ r: o }) => (down ? o.top > r.top + 4 : o.top < r.top - 4))
        .sort((a, b) =>
          (down ? a.r.top - b.r.top : b.r.top - a.r.top) || Math.abs(a.r.left - r.left) - Math.abs(b.r.left - r.left));
      const row = below[0]?.r.top;
      const same = below.filter((b) => b.r.top === row).sort((a, b) => Math.abs(a.r.left - r.left) - Math.abs(b.r.left - r.left));
      next = same[0]?.k ?? i;
    } else next = e.key === "ArrowRight" ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1);
    if (next !== i) {
      e.preventDefault();
      items[next]?.focus();
    }
  };
  node.addEventListener("keydown", onKey);
  return { destroy: () => node.removeEventListener("keydown", onKey) };
}


export interface MenuItem { label: string; icon?: string; danger?: boolean; action: () => void }
