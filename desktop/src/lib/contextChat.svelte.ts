// "Neuer Chat mit Kontext" (⋯ menu, ⌘⇧L, ⌘K): a fork of a session (server `fork`) that opens as an ordinary tab
// right next to the session's tab and gets the focus. Its own ⋯ menu resets it (a fresh fork of the session as it
// is now, in the same tab) or puts its result into the session's composer as a draft (never sent).
import * as api from "./api";
import type { Pane, TimelineItem } from "./api";
import { t } from "./i18n";
import { draftKey } from "./drafts";
import { drafts, findPane, go, refresh, tabName } from "./store.svelte";
import { speech } from "./speech.svelte";
import { stopLiveOn } from "./live.svelte";
import { appendDraft, chatTranscript, historyCut } from "./contextChatText";

/** what runs now ("serverId|pane" of the session being forked or the chat being reset), the last error and whose */
export const contextChat = $state({ busy: "", error: "", errorFor: "" });

/** sessions whose agent log the server can copy */
export const canFork = (pane: Pane) => pane.agent === "omp" || pane.agent === "claude";

/** What `fork` errors mean for the user. */
export function forkError(e: unknown): string {
  const code = e instanceof Error ? e.message : String(e);
  if (code === "not_allowed") return t("Hollr auf dem Server ist zu alt dafür – unter Server › Werkzeuge aktualisieren.");
  if (code === "not_found") return t("Diese Sitzung gibt es nicht mehr.");
  if (code === "no_session") return t("Diese Sitzung hat noch keinen Verlauf – erst etwas schreiben, dann einen Chat mit Kontext starten.");
  if (code === "unsupported") return t("Chats mit Kontext gibt es für omp und Claude Code.");
  if (code === "not_a_fork") return t("Dieser Chat ist keine Abzweigung (mehr) – bitte neu starten.");
  return t("Chat mit Kontext nicht gestartet: {e}", { e: code });
}

/** the session's shown name – the fork's tab is called the same */
function nameOf(server: string, pane: string) {
  const r = findPane(server, pane);
  return r ? tabName(r.tab.label, r.workspace.label) : "";
}

async function run(server: string, of: string, replace?: string) {
  const id = `${server}|${replace ?? of}`;
  if (contextChat.busy) return;
  contextChat.busy = id;
  contextChat.error = contextChat.errorFor = "";
  try {
    // a reset closes the old chat's pane: a call there would only break off
    if (replace) await stopLiveOn(server, replace);
    const r = await api.fork(server, of, nameOf(server, of), replace);
    await refresh(server);
    go({ view: "agent", server, pane: r.pane });
  } catch (e) {
    contextChat.error = forkError(e);
    contextChat.errorFor = id;
  } finally {
    contextChat.busy = "";
  }
}

/** A new chat with `pane`'s history, opened and focused in a tab next to it. */
export const startContextChat = (server: string, pane: string) => run(server, pane);

/** A fresh fork of the session `fork` continues, in `fork`'s tab (its chat is empty again). */
export function resetContextChat(server: string, fork: Pane) {
  if (fork.fork) return run(server, fork.fork.of, fork.pane);
}

/** The chat's result (what was said after the fork, summarized) as a draft below the source session's draft –
 *  then that session is shown. Never sent. */
export async function chatResult(server: string, fork: Pane, items: TimelineItem[]) {
  const of = fork.fork?.of;
  if (!of) return;
  const transcript = chatTranscript(items.slice(historyCut(items, fork.fork?.at ?? 0)), { user: "User", agent: "Agent" });
  if (!transcript) throw new Error(t("In diesem Chat wurde noch nichts gesagt."));
  // the read-aloud model is only known to exist on the server it was picked for; no language: the draft is for the
  // source session's agent, in the language of the conversation
  const s = speech.summary;
  const model = !s.server || s.server === server ? s.model || undefined : undefined;
  let text: string;
  try {
    text = (await api.summarize(server, { text: transcript, model, lang: "", style: "handoff" })).summary.trim();
  } catch (e) {
    const code = e instanceof Error ? e.message : String(e);
    throw new Error(code === "not_allowed" ? t("Hollr auf dem Server ist zu alt – unter Server › Werkzeuge aktualisieren.") : t("Zusammenfassen fehlgeschlagen: {e}", { e: code }));
  }
  const key = draftKey(server, of);
  drafts.setText(key, appendDraft(drafts.text(key), text));
  go({ view: "agent", server, pane: of });
}
