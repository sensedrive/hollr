// The side conversation's window (src-tauri/src/window.rs): opening / focusing it, its result for the main window.
import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n";

/** Window and tab title of `main`'s side conversation. */
export const sideTitle = (main: string) => `🎙 ${t("Nebengespräch")} · ${main}`;

/** Opens `main`'s side window on fork `pane` (or brings it to the front); `live`: start Live once the fork is ready. */
export const openSide = (server: string, main: string, pane: string, title: string, live: boolean) =>
  invoke<void>("side_window", { server, main, pane, title, live });

/** The result as a draft in the main window's composer; false when the main window is closed. */
export const sendResult = (server: string, main: string, text: string) =>
  invoke<boolean>("side_result", { server, main, text }).then((sent) => sent === true);

export const focusMain = () => invoke<boolean>("main_window_focus").then((ok) => ok === true);

/** What `fork` errors mean for the user. */
export function forkError(e: unknown): string {
  const code = e instanceof Error ? e.message : String(e);
  if (code === "not_allowed") return t("Hollr auf dem Server ist zu alt für Nebengespräche – unter Server › Werkzeuge aktualisieren.");
  if (code === "not_found") return t("Diese Sitzung gibt es nicht mehr.");
  if (code === "no_session") return t("Diese Sitzung hat noch keinen Verlauf – erst etwas schreiben, dann nebenbei darüber reden.");
  if (code === "unsupported") return t("Nebengespräche gibt es für omp und Claude Code.");
  if (code === "not_a_fork") return t("Das Nebengespräch gibt es nicht mehr – bitte neu starten.");
  return t("Nebengespräch nicht gestartet: {e}", { e: code });
}
