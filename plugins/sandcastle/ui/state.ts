/** What the views share: loaded data, the chosen project, and the reload hooks app.ts fills in. */
import type { Board, Project, RunResponse } from "./types";

export const state = {
  projects: [] as Project[],
  projectId: "",
  view: "board" as "board" | "run",
  board: null as Board | null,
  run: null as RunResponse | null,
  /** story filter: "all", "none" (without a story) or a story number */
  filter: "all",
};

export const currentProject = () => state.projects.find((p) => p.id === state.projectId);

export const hooks = {
  reloadBoard: async (): Promise<void> => {},
  reloadRun: async (): Promise<void> => {},
};

/** Reloads both: a change on one shows on the other (and on the run pill). */
export const reloadAll = () => Promise.all([hooks.reloadBoard(), hooks.reloadRun()]);

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(message: string): void {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.setAttribute("role", "alert");
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el?.classList.remove("show"), 6000);
}

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Numbers in the queue's current order – from the board, else from the run view. */
export function queueOrder(): number[] {
  const cards = state.board?.columns.queue ?? state.run?.queue ?? state.run?.run?.queue ?? [];
  return cards.map((c) => c.number);
}
