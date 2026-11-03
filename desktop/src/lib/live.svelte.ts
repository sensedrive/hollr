// The app's one omp /live call (AgentSession.swift's live part): it outlives the session view, so
// leaving the view (tabs, sidebar, dashboard, a notification) doesn't hang up. The session's live
// bar, the app-wide live pill and the tab markers all read this store.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t } from "./i18n";
import { settings } from "./settings.svelte";

/** "" = no call (server/pane may still name the last one for its error / note);
 *  "lost" = the connection died mid-call – offers "Neu verbinden" */
export type LivePhase = "" | "connecting" | "live" | "ending" | "lost";

export const live = $state({
  server: "",
  /** herdr pane id (like route.pane) */
  pane: "",
  /** session title, for the live pill */
  label: "",
  phase: "" as LivePhase,
  /** omp's own state: listening / speaking / thinking / working / muted */
  ompState: undefined as string | undefined,
  speakerMuted: false,
  levels: { input: 0, output: 0 },
  /** why the call failed or was lost */
  error: "",
  /** how it ended (e.g. at the computer itself) */
  note: "",
  /** microphone / speaker trouble – the call goes on, cleared once the audio is back */
  audioError: "",
  /** the audio devices in use ("MacBook Pro-Mikrofon · AirPods") */
  devices: "",
  /** id from live_start; events of other (older) calls are ignored */
  session: null as number | null,
});

/** a call is running or starting / ending */
export const liveActive = () => live.phase === "connecting" || live.phase === "live" || live.phase === "ending";
/** a call runs on this pane */
export const liveOn = (server: string, pane: string) => liveActive() && live.server === server && live.pane === pane;
/** the store's state is about this pane (running, lost, or its last error / note) */
export const liveAbout = (server: string, pane: string) => live.server === server && live.pane === pane;
export const micMuted = () => live.ompState === "muted";

/** omp's live state in words */
export function liveStateLabel(s?: string) {
  if (!s) return t("verbunden");
  return ({ listening: t("hört zu"), speaking: t("spricht"), working: t("arbeitet"), thinking: t("arbeitet"), muted: t("stumm"), connecting: t("verbindet") } as Record<string, string>)[s] ?? s;
}

/** the live bar's / pill's color: muted orange, working purple, listening green, lost red */
export function liveColor() {
  if (live.phase === "lost") return "var(--red)";
  if (micMuted()) return "var(--orange)";
  if (live.phase !== "live") return "var(--accent)";
  return live.ompState === "working" || live.ompState === "thinking" ? "var(--purple)" : "var(--green)";
}

/** the bar's second line: omp's state, mic / speaker off – or what's happening */
export function liveDetail() {
  if (live.phase === "live") return [micMuted() ? t("Mikro aus") : liveStateLabel(live.ompState), live.speakerMuted ? t("Ton aus") : ""].filter(Boolean).join(" · ");
  if (live.phase === "lost") return live.error;
  return "omp /live";
}

export function liveTitle() {
  return live.phase === "connecting" ? t("Verbinde …") : live.phase === "ending" ? t("Beende …") : live.phase === "lost" ? t("Verbindung verloren") : "Live";
}

let listening: Promise<unknown> | undefined;
/** events that arrived before live_start returned the id */
let early: Record<string, unknown>[] = [];
/** "Beenden" while live_start was still under way */
let cancelled = false;
let starts = 0;

function listenOnce() {
  listening ??= Promise.all([
    listen<Record<string, unknown>>("live", (e) => {
      if (live.session === null) {
        if (live.phase === "connecting" || live.phase === "ending") early.push(e.payload);
      } else if (e.payload.session === live.session) onEvent(e.payload);
    }),
    listen<{ input: number; output: number; session?: number }>("live-levels", (e) => {
      if (e.payload.session === live.session) live.levels = { input: e.payload.input, output: e.payload.output };
    }),
  ]);
  return listening;
}

/** Starts Live on a pane; a call on another pane ends (the computer has one microphone). */
export async function startLive(server: string, pane: string, label: string) {
  Object.assign(live, {
    server, pane, label, phase: "connecting", ompState: undefined, speakerMuted: false, levels: { input: 0, output: 0 },
    error: "", note: "", audioError: "", devices: "", session: null,
  });
  early = [];
  cancelled = false;
  const mine = ++starts;
  await listenOnce();
  try {
    const id = await invoke<number>("live_start", { server, pane, headphones: settings.liveHeadphones });
    if (mine !== starts) return; // a newer start already replaced this call
    if (cancelled) {
      await invoke("live_stop", { session: id }).catch(() => {});
      return endLive();
    }
    live.session = id;
    for (const m of early.splice(0)) if (m.session === id) onEvent(m);
  } catch (e) {
    if (mine !== starts) return;
    live.error = String(e);
    endLive();
  }
}

/** Same pane again after a lost connection (like starting it anew – the server cleaned up). */
export const reconnectLive = () => startLive(live.server, live.pane, live.label);

function onEvent(m: Record<string, unknown>) {
  switch (m.t) {
    case "phase":
      if (m.phase === "live") live.phase = "live";
      else if (m.phase === "ended") {
        if (m.reason === "live_stopped") live.note = t("Live wurde am Rechner beendet.");
        // the server gave up on us (it heard nothing for 20 s): the same as a lost connection
        if (m.reason === "disconnected" && live.phase !== "ending" && !live.error) return lost(t("Verbindung unterbrochen – bitte neu verbinden."));
        if (m.reason === "start_failed" && !live.error) live.error = t("Live konnte auf dem Server nicht starten.");
        endLive();
      } else if (m.phase === "failed") {
        live.error = String(m.message ?? m.reason ?? t("Live fehlgeschlagen"));
        endLive();
      }
      break;
    case "omp":
      live.ompState = String(m.state);
      break;
    case "error":
      live.error = String(m.message ?? m.code);
      break;
    case "audio_error":
      live.audioError = String(m.message);
      break;
    case "audio":
      live.audioError = "";
      live.devices = [m.input, m.output].filter(Boolean).join(" · ");
      break;
    case "lost":
      lost(t("Verbindung verloren – keine Antwort vom Server."));
      break;
    case "closed":
      // ended / hung up / failed: over; otherwise the channel died under a running call
      if (live.phase === "ending" || live.error) endLive();
      else lost(t("Verbindung zum Server wurde unerwartet beendet."));
      break;
  }
}

function lost(message: string) {
  live.phase = "lost";
  live.error = message;
  live.session = null;
  live.ompState = undefined;
  live.speakerMuted = false;
  live.audioError = "";
  live.levels = { input: 0, output: 0 };
}

function endLive() {
  live.phase = "";
  live.session = null;
  live.ompState = undefined;
  live.speakerMuted = false;
  live.audioError = "";
  live.levels = { input: 0, output: 0 };
  early = [];
}

/** Hangs up the running call (only that one – the id goes along); a lost / failed call is just dismissed. */
export async function stopLive() {
  if (!liveActive()) return dismissLive();
  if (live.phase === "ending") return;
  live.phase = "ending";
  const id = live.session;
  if (id === null) {
    cancelled = true; // startLive stops it once live_start returns
    return;
  }
  await invoke("live_stop", { session: id }).catch(() => {});
  // the server's "ended" normally comes within a second or two
  setTimeout(() => { if (live.phase === "ending" && live.session === id) endLive(); }, 6000);
}

/** Hangs up if the call is on this pane (the pane is being closed). */
export async function stopLiveOn(server: string, pane: string) {
  if (liveAbout(server, pane)) await stopLive();
}

/** Forgets a finished / lost call's message. */
export function dismissLive() {
  if (liveActive()) return;
  endLive();
  Object.assign(live, { server: "", pane: "", label: "", error: "", note: "", devices: "" });
}

export function toggleLiveMic() {
  if (live.session === null) return;
  live.ompState = micMuted() ? "listening" : "muted"; // optimistic, omp confirms
  void invoke("live_mute", { session: live.session, on: live.ompState === "muted" }).catch(() => {});
}

export function toggleLiveSpeaker() {
  if (live.session === null) return;
  live.speakerMuted = !live.speakerMuted;
  void invoke("live_speaker", { session: live.session, muted: live.speakerMuted }).catch(() => {});
}

/** Settings › "Kopfhörer": mic stays open while omp speaks; a running call follows at once. */
export function setLiveHeadphones(on: boolean) {
  settings.liveHeadphones = on;
  void invoke("live_headphones", { on }).catch(() => {});
}
