// Local dictation (iOS Dictator / DictationSettings / ModelManager): settings in localStorage, the downloaded
// Whisper models, and the one dictation the app runs at a time. Recording and Whisper run in Rust
// (dictation.rs); the text cleanup is dictationText.ts.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t } from "./i18n";
import { DEFAULT_VOCABULARY, finishText, LANGUAGES, promptTerms, type Replacement } from "./dictationText";
import { liveActive } from "./live.svelte";

const KEY = "hollr.dictation";

export interface DictationSettings {
  /** ggml model id (WHISPER_MODELS) */
  whisperModel: string;
  /** "de", "en", … or "auto" */
  language: string;
  /** send right after dictating */
  autoSend: boolean;
  /** "… senden" at the end sends the message */
  voiceSend: boolean;
  /** one term per line, misheard variants after "=" */
  vocabularyText: string;
  /** vocabulary into Whisper's prompt and spelling fixes afterwards */
  useVocabulary: boolean;
  /** Whisper retries with higher temperature when the result looks wrong (0 = off) */
  whisperFallbacks: number;
  /** drop "ähm", "äh" … */
  removeFillers: boolean;
  /** words from the open session (folder, tickets, files) help recognition */
  sessionVocabulary: boolean;
  replacements: Replacement[];
}

const preferred = (navigator.language || "de").slice(0, 2).toLowerCase();
const defaults: DictationSettings = {
  whisperModel: "large-v3-turbo-q5_0",
  language: LANGUAGES.some((l) => l.code === preferred) ? preferred : "de",
  autoSend: false,
  voiceSend: true,
  vocabularyText: DEFAULT_VOCABULARY,
  useVocabulary: true,
  whisperFallbacks: 3,
  removeFillers: true,
  sessionVocabulary: true,
  replacements: [],
};

function load(): DictationSettings {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { ...defaults };
  }
}

export const dictation = $state<DictationSettings>(load());

$effect.root(() => {
  $effect(() => {
    const snapshot = JSON.stringify(dictation);
    try {
      localStorage.setItem(KEY, snapshot);
    } catch {}
  });
});
// changed in the other window (side conversation): the same values here, so this one never writes back an old copy
if (typeof window !== "undefined")
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) Object.assign(dictation, load());
  });

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ------------------------------------------------------------ models

type DownloadEvent = { id: string; progress?: number; done?: boolean; cancelled?: boolean; error?: string };

/** downloaded models (id → bytes), running downloads (id → 0…1) and the last error per model */
export const models = $state<{ local: Record<string, number>; progress: Record<string, number>; errors: Record<string, string> }>({
  local: {},
  progress: {},
  errors: {},
});

let downloadEvents: Promise<unknown> | null = null;

export async function refreshModels() {
  const list = await invoke<{ id: string; bytes: number }[] | null>("dictation_models").catch(() => null);
  models.local = Object.fromEntries((list ?? []).map((m) => [m.id, m.bytes]));
}

export async function downloadModel(id: string) {
  downloadEvents ??= listen<DownloadEvent>("dictation-download", ({ payload: e }) => {
    if (e.progress !== undefined) {
      if (e.id in models.progress) models.progress[e.id] = e.progress;
      return;
    }
    delete models.progress[e.id];
    if (e.error) models.errors[e.id] = e.error;
    if (e.done) refreshModels();
  });
  await downloadEvents;
  models.progress[id] = 0;
  delete models.errors[id];
  try {
    await invoke("dictation_download", { id });
  } catch (e) {
    delete models.progress[id];
    models.errors[id] = message(e);
  }
}

export const cancelDownload = (id: string) => invoke("dictation_download_cancel", { id }).catch(() => {});

export async function deleteModel(id: string) {
  try {
    await invoke("dictation_delete", { id });
  } catch (e) {
    models.errors[id] = message(e);
  }
  await refreshModels();
}

/** Loads the chosen model before the first dictation (a chat opened). */
export function prewarm() {
  if (dictation.whisperModel in models.local) invoke("dictation_prewarm", { model: dictation.whisperModel }).catch(() => {});
}

refreshModels();

// ------------------------------------------------------------ the dictation

type Phase = "idle" | "preparing" | "recording" | "transcribing" | "failed";
type Event = { session: number; t: "level" | "text" | "interrupted"; level?: number; text?: string };
type Outcome = { text: string; seconds: number; tail_failed: boolean };

/** One microphone, one dictation in the whole app. It belongs to a chat (draft key) and is not stopped
 *  by a composer that goes away for a moment (zen mode); leaving the chat ends it and keeps the text. */
class Dictator {
  state = $state<Phase>("idle");
  /** why the last start/stop failed */
  error = $state("");
  /** recognised text so far (chunk by chunk while recording), the cleaned result after stop */
  text = $state("");
  level = $state(0);
  /** short notice after a dictation ("Nichts verstanden", "Aufnahme unterbrochen" …) */
  notice = $state("");
  /** the chat this dictation belongs to */
  owner = $state<string | null>(null);
  /** where `error` / `notice` belong */
  noticeFor = $state<string | null>(null);

  /** where the result goes – set at start, not by a view */
  private deliver: ((text: string) => void) | null = null;
  private session: number | null = null;
  /** events that arrived before dictation_start returned the session id */
  private early: Event[] = [];
  /** bumped by every start and cancel: work of an older dictation is dropped */
  private generation = 0;
  /** stop was asked for while the microphone was still starting (released hold-to-talk early) */
  private stopWhenReady = false;
  /** the session's words, also used for the spelling fixes afterwards */
  private extra: string[] = [];
  private visible: Record<string, number> = {};
  private events: Promise<unknown> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  get isRecording() {
    return this.state === "recording";
  }
  get isBusy() {
    return this.state === "preparing" || this.state === "recording" || this.state === "transcribing";
  }

  private onEvent(e: Event) {
    if (e.t === "level") this.level = e.level ?? 0;
    else if (e.t === "text" && this.state === "recording") this.text = e.text ?? "";
    else if (e.t === "interrupted") this.interrupted();
  }

  private async interrupted() {
    if (this.state !== "recording") return;
    const owner = this.owner;
    await this.finish();
    // (the state changed during finish – TypeScript still narrows it to "recording")
    if ((this.state as Phase) !== "failed") this.say(t("Aufnahme unterbrochen – das Gesagte ist eingefügt."), owner);
  }

  private say(notice: string, owner: string | null) {
    this.notice = notice;
    this.noticeFor = owner;
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => (this.notice = ""), 8000);
  }

  async start(owner: string, extra: string[], deliver?: (text: string) => void) {
    // omp /live has the microphone (the composer's mic button says so)
    if (this.isBusy || liveActive()) return;
    const gen = ++this.generation;
    // busy right away: a second click during the (slow) start must not start a second recording
    this.state = "preparing";
    this.stopWhenReady = false;
    this.owner = owner;
    this.noticeFor = owner;
    this.deliver = deliver ?? null;
    this.extra = dictation.sessionVocabulary ? extra : [];
    this.text = "";
    this.notice = "";
    this.error = "";
    this.level = 0;
    this.session = null;
    this.early = [];
    try {
      this.events ??= listen<Event>("dictation", ({ payload }) => {
        if (this.session === null) this.early.push(payload);
        else if (payload.session === this.session) this.onEvent(payload);
      });
      await this.events;
      if (!(dictation.whisperModel in models.local)) await refreshModels();
      if (!(dictation.whisperModel in models.local)) throw new Error(t("Whisper-Modell noch nicht geladen (Einstellungen › Diktat)."));
      const id = await invoke<number>("dictation_start", {
        model: dictation.whisperModel,
        language: dictation.language,
        vocabulary: promptTerms(dictation, this.extra).slice(0, 40),
        fallbacks: dictation.whisperFallbacks,
      });
      // cancelled (or restarted) while the microphone was starting
      if (gen !== this.generation) {
        if (!this.isBusy) invoke("dictation_cancel").catch(() => {});
        return;
      }
      this.session = id;
      for (const e of this.early.splice(0)) if (e.session === id) this.onEvent(e);
      this.state = "recording";
      if (this.stopWhenReady) {
        this.stopWhenReady = false;
        await this.finish();
      }
    } catch (e) {
      if (gen !== this.generation) return;
      this.owner = null;
      this.deliver = null;
      // the backend answers in German; known messages have an English translation
      this.error = t(message(e));
      this.state = "failed";
    }
  }

  /** Stops and hands the text to whoever started the dictation. */
  async finish() {
    if (this.state === "preparing") {
      this.stopWhenReady = true;
      return;
    }
    if (this.state !== "recording") return;
    const deliver = this.deliver;
    this.deliver = null;
    const text = await this.stop();
    this.owner = null;
    deliver?.(text);
  }

  /** Stops recording and returns the final text (cleaned up, vocabulary applied). */
  async stop(): Promise<string> {
    if (this.state !== "recording") return "";
    const gen = this.generation;
    const owner = this.owner;
    this.state = "transcribing";
    this.level = 0;
    let out: Outcome | null;
    try {
      out = await invoke<Outcome | null>("dictation_stop");
    } catch (e) {
      if (gen !== this.generation) return "";
      this.session = null;
      this.error = t(message(e));
      this.state = "failed";
      return "";
    }
    if (gen !== this.generation) return "";
    this.session = null;
    const cleaned = finishText(out?.text ?? "", dictation, this.extra);
    if (!cleaned) this.say((out?.seconds ?? 0) < 0.6 ? t("Zu kurz – etwas länger sprechen.") : t("Nichts verstanden."), owner);
    else if (out?.tail_failed) this.say(t("Der letzte Teil wurde nicht erkannt."), owner);
    this.text = cleaned;
    this.state = "idle";
    return cleaned;
  }

  /** Throws the recording away. */
  cancel() {
    this.generation++;
    this.stopWhenReady = false;
    if (this.isBusy) invoke("dictation_cancel").catch(() => {});
    this.session = null;
    this.owner = null;
    this.deliver = null;
    this.text = "";
    this.level = 0;
    this.state = "idle";
  }

  composerAppeared(key: string) {
    this.visible[key] = (this.visible[key] ?? 0) + 1;
  }

  /** The chat's last composer is gone (left the chat): end the dictation, keep the text. */
  composerDisappeared(key: string) {
    this.visible[key] = Math.max((this.visible[key] ?? 1) - 1, 0);
    if (key !== this.owner) return;
    // zen mode / a new layout swaps the composer: the new one appears right after the old one went away
    setTimeout(() => {
      if (this.owner === key && !this.visible[key]) this.finish();
    }, 400);
  }
}

export const dictator = new Dictator();
