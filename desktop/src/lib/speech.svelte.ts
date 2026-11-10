// Read aloud: settings in localStorage, the Phonon models and their voices (speech.rs), the selection on
// offer (chat or terminal, ReadAloud.svelte shows the buttons), spoken summaries (made by the server's omp)
// and the one thing the app reads at a time. Cleanup, language detection, summary keys: speechText.ts.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { summarize } from "./api";
import { lang as uiLang, t } from "./i18n";
import { detectLanguage, speakable, summaryKey, type SpeechLang } from "./speechText";

const KEY = "hollr.speech";

export interface SpeechSettings {
  /** "auto": Phonon when a downloaded model speaks the language, else the system voice; "system": always the system voice */
  engine: "auto" | "system";
  /** the preferred Phonon model (PHONON_MODELS id) */
  model: string;
  /** Phonon voice per language ("" = the model's own) */
  voices: Partial<Record<SpeechLang, string>>;
  /** SPEED.min … SPEED.max (Phonon: duration_delta, system voice: words per minute) */
  speed: number;
  /** the "Vorlesen" / "Zusammenfassung" buttons next to selected text */
  button: boolean;
  summary: SummarySettings;
}

export type SummaryLength = "kurz" | "mittel";

export interface SummarySettings {
  /** whose models Settings lists and tests with ("" = the first server with omp); a summary itself runs on
   *  the server the text was selected on */
  server: string;
  /** omp model selector ("" = the server's fast model) */
  model: string;
  /** kurz ≈ 2–3 sentences, mittel ≈ 5–7 */
  length: SummaryLength;
  /** read the original right after the summary */
  thenOriginal: boolean;
}

const defaults: SpeechSettings = {
  engine: "auto", model: "phonon-40m-multilingual", voices: {}, speed: 1, button: true,
  summary: { server: "", model: "", length: "kurz", thenOriginal: false },
};

function load(): SpeechSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<SpeechSettings>;
    return { ...defaults, ...stored, summary: { ...defaults.summary, ...stored.summary } };
  } catch {
    return { ...defaults, summary: { ...defaults.summary } };
  }
}

export const speech = $state<SpeechSettings>(load());

$effect.root(() => {
  $effect(() => {
    const snapshot = JSON.stringify(speech);
    try {
      localStorage.setItem(KEY, snapshot);
    } catch {}
  });
});

export interface PhononModel {
  id: string;
  name: string;
  /** download size (Ollama registry, BF16 weights) */
  size: string;
  languages: SpeechLang[];
  license: string;
  note: string;
}

// Gradium's checkpoints as Ollama's registry hosts them (library/phonon:<tag>) – no Hugging Face login
export const PHONON_MODELS: PhononModel[] = [
  { id: "phonon-40m-multilingual", name: "Phonon 40m multilingual", size: "148 MB", languages: ["de", "en", "fr", "es", "pt"],
    license: "CC BY-NC 4.0", note: "Deutsch, Englisch, Französisch, Spanisch, Portugiesisch – empfohlen" },
  { id: "phonon-40m-de", name: "Phonon 40m de", size: "126 MB", languages: ["de"], license: "CC BY-NC 4.0", note: "Nur Deutsch" },
  { id: "phonon-40m-en", name: "Phonon 40m en", size: "132 MB", languages: ["en"], license: "CC BY-NC 4.0", note: "Nur Englisch" },
  { id: "phonon-31m-en", name: "Phonon 31m en", size: "104 MB", languages: ["en"], license: "Apache 2.0", note: "Nur Englisch" },
];

export const modelPage = (id: string) => `https://ollama.com/library/phonon:${id.replace(/^phonon-/, "")}`;
export const LANG_NAMES: Record<SpeechLang, string> = { de: "Deutsch", en: "Englisch", fr: "Französisch", es: "Spanisch", pt: "Portugiesisch" };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** the dev bridge (normal browser) has no audio: speaking is only logged and shown */
const viaBridge = new URLSearchParams(location.search).has("bridge");

// ------------------------------------------------------------ models and voices

type LocalModel = { id: string; bytes: number; languages: string[]; speed: boolean; voices: string[]; attribution: string | null };
type EngineInfo = { engine: "phonon" | "system"; label: string | null };
type Status = { system: boolean; models: LocalModel[]; engines: Record<string, EngineInfo | null> };
type DownloadEvent = { id: string; progress?: number; done?: boolean; cancelled?: boolean; error?: string };

/** what Rust reports (null until the first answer / in the browser), running downloads (id → 0…1), errors */
export const speechState = $state<{ status: Status | null; progress: Record<string, number>; errors: Record<string, string> }>({
  status: null,
  progress: {},
  errors: {},
});

export async function refreshSpeech() {
  speechState.status = await invoke<Status | null>("speech_status", { engine: speech.engine, model: speech.model }).catch(() => null);
}

export const localModel = (id: string) => speechState.status?.models.find((m) => m.id === id);

let downloadEvents: Promise<unknown> | null = null;

export async function downloadPhonon(id: string) {
  downloadEvents ??= listen<DownloadEvent>("speech-download", ({ payload: e }) => {
    if (e.progress !== undefined) {
      if (e.id in speechState.progress) speechState.progress[e.id] = e.progress;
      return;
    }
    delete speechState.progress[e.id];
    if (e.error) speechState.errors[e.id] = t(e.error);
    if (e.done) refreshSpeech();
  });
  await downloadEvents;
  speechState.progress[id] = 0;
  delete speechState.errors[id];
  try {
    await invoke("speech_download", { id });
  } catch (e) {
    delete speechState.progress[id];
    speechState.errors[id] = t(message(e));
  }
}

export const cancelPhonon = (id: string) => invoke("speech_download_cancel", { id }).catch(() => {});

export async function deletePhonon(id: string) {
  try {
    await invoke("speech_delete", { id });
  } catch (e) {
    speechState.errors[id] = message(e);
  }
  await refreshSpeech();
}

export type ModelVoice = { name: string; language: string | null; locale: string | null; gender: string | null; description: string | null };

/** The chosen model's voices (with Gradium's catalog data where known) and each language's default one. */
export async function loadVoices(): Promise<{ voices: ModelVoice[]; defaults: Partial<Record<SpeechLang, string>> } | null> {
  return await invoke<{ voices: ModelVoice[]; defaults: Partial<Record<SpeechLang, string>> } | null>("speech_voices", { model: speech.model });
}

refreshSpeech();

// ------------------------------------------------------------ the selection on offer

export type Source = "chat" | "terminal";
export interface Offer {
  text: string;
  source: Source;
  /** the server the chat / terminal belongs to: a summary is made there */
  server?: string;
  /** where the button goes (viewport px) */
  x: number;
  y: number;
}

/** selected text that can be read (one at a time: the last selection made) */
export const selection = $state<{ offer: Offer | null }>({ offer: null });

/** the text whose offer button was clicked away; the same selection doesn't bring it back */
let dismissed = "";

export function offerSelection(offer: Offer) {
  if (offer.text === dismissed) return;
  dismissed = "";
  selection.offer = offer;
  speaker.prewarm(offer.text);
}

/** hide the button; the selection itself stays */
export function dismissSelection() {
  dismissed = selection.offer?.text ?? dismissed;
  selection.offer = null;
}

/** `source` let go of its selection */
export function withdrawSelection(source: Source) {
  if (selection.offer?.source === source) selection.offer = null;
}

// ------------------------------------------------------------ spoken summaries

type Summary = { summary: string; model: string };
/** this session's summaries (text hash, model, length): reading one again starts right away */
const summaries = new Map<string, Summary>();

/** A spoken summary of `text`, made by omp on `server` with the chosen model and length. */
export async function summaryOf(server: string, text: string, lang: SpeechLang): Promise<Summary> {
  const { model, length } = speech.summary;
  const key = summaryKey(text, model, length);
  const known = summaries.get(key);
  if (known) return known;
  // the server keeps 40k characters (head and tail) anyway – no need to send megabytes
  const sent = text.length > 200_000 ? `${text.slice(0, 100_000)}\n…\n${text.slice(-100_000)}` : text;
  const made = await summarize(server, { text: sent, model: model || undefined, lang, length });
  summaries.set(key, made);
  return made;
}

/** The server's error code → what the pill / Settings say. */
export function summaryError(e: unknown): string {
  const code = message(e);
  if (code === "not_allowed") return t("Dieser Server kann noch nicht zusammenfassen – Hollr auf dem Server aktualisieren.");
  if (code === "no_agent") return t("Auf dem Server ist weder omp noch Claude Code installiert.");
  if (code === "no_model") return t("omp ist auf dem Server bei keinem Anbieter angemeldet.");
  if (code === "timeout") return t("Die Zusammenfassung hat zu lange gedauert.");
  if (code === "empty_summary") return t("Das Modell hat keine Zusammenfassung geliefert.");
  return t("Zusammenfassung fehlgeschlagen: {error}", { error: t(code) });
}

/** "anthropic/claude-haiku-5-5" → "claude-haiku-5-5" (the pill has little room) */
export const shortModel = (model: string) => model.slice(model.lastIndexOf("/") + 1);

// ------------------------------------------------------------ the speaker

type SpeechEvent = { session: number; t: "playing" | "end" | "error"; error?: string; warning?: string | null };
type Started = { session: number } & EngineInfo;
type Phase = "idle" | "summarizing" | "loading" | "speaking";

/** What the reading panel shows – it stays until closed: the selection read last and, once made, its summary. */
export interface Reading {
  /** the selection as it was given (Markdown, terminal text) */
  original: string;
  /** the server it came from: a summary can be made there */
  server?: string;
  summary: string | null;
  /** the model that makes / made the summary ("" = the server's fast one, until it says which) */
  model: string;
  /** which of the two is (or was last) read */
  showing: "original" | "summary";
  /** why the summary failed */
  error: string;
}

/** The speaking rate's range (Settings and the panel); speech.rs clamps to 0.5 … 2. Phonon itself only
 *  goes from about 0.8× to 1.3× (duration_delta), the system voice covers all of it. */
export const SPEED = { min: 0.7, max: 1.6, step: 0.1 };

/** One voice in the whole app: a new request stops the old one. */
class Speaker {
  state = $state<Phase>("idle");
  /** what speaks: "phonon" | "system" (and the model / voice) */
  engine = $state<EngineInfo | null>(null);
  lang = $state<SpeechLang>("de");
  /** the last error / warning, shown for a few seconds */
  notice = $state("");
  failed = $state(false);
  reading = $state<Reading | null>(null);

  private session: number | null = null;
  private early: SpeechEvent[] = [];
  private generation = 0;
  private events: Promise<unknown> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private previewTimer: ReturnType<typeof setTimeout> | undefined;
  private warmed = "";
  /** read the original once the summary is through ("Zusammenfassung, danach Original") */
  private thenOriginal = false;

  get busy() {
    return this.state !== "idle";
  }

  private request(text: string) {
    // too little to tell: the UI's language
    const lang = detectLanguage(text, uiLang() === "en" ? "en" : "de");
    return { text, lang, engine: speech.engine, model: speech.model, voice: speech.voices[lang] ?? "", speed: speech.speed };
  }

  private say(notice: string, failed = false) {
    this.notice = notice;
    this.failed = failed;
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => (this.notice = ""), 6000);
  }

  private onEvent(e: SpeechEvent) {
    if (e.t === "playing") {
      this.state = "speaking";
      if (e.warning) this.say(t(e.warning));
    } else {
      if (e.t === "error") this.say(t(e.error ?? ""), true);
      this.session = null;
      this.state = "idle";
      if (e.t === "end") this.finished();
      else this.thenOriginal = false;
    }
  }

  /** Read to the end: the original follows the summary if the setting says so. */
  private finished() {
    if (!this.thenOriginal) return;
    this.thenOriginal = false;
    this.readOriginal();
  }

  /** Loads the model the next request would need (text got selected), so it starts right away. */
  prewarm(raw: string) {
    const r = this.request(speakable(raw));
    const key = `${r.lang}|${r.engine}|${r.model}|${r.speed}`;
    if (!r.text || key === this.warmed) return;
    this.warmed = key;
    invoke("speech_prewarm", { request: r }).catch(() => {});
  }

  /** Reads `raw` (a selection from `server`, or a test text) as it is; the panel shows it. */
  async speak(raw: string, server?: string) {
    if (!speakable(raw)) return this.say(t("Nichts zum Vorlesen markiert."));
    this.reading = { original: raw, server, summary: null, model: "", showing: "original", error: "" };
    await this.play(raw);
  }

  /** Speaks `raw` (cleaned up first); `thenOriginal`: the reading's original follows. */
  private async play(raw: string, thenOriginal = false) {
    const text = speakable(raw);
    if (!text) return this.say(t("Nichts zum Vorlesen markiert."));
    const gen = ++this.generation;
    const r = this.request(text);
    clearTimeout(this.previewTimer);
    this.state = "loading";
    this.lang = r.lang;
    this.notice = "";
    this.thenOriginal = thenOriginal;
    this.session = null;
    this.early = [];
    try {
      this.events ??= listen<SpeechEvent>("speech", ({ payload }) => {
        if (this.session === null) this.early.push(payload);
        else if (payload.session === this.session) this.onEvent(payload);
      });
      await this.events;
      const started = await invoke<Started | null>("speech_speak", { request: r });
      if (gen !== this.generation) return;
      if (!started) return this.preview(r.text, r.lang);
      this.session = started.session;
      this.engine = { engine: started.engine, label: started.label };
      for (const e of this.early.splice(0)) if (e.session === started.session) this.onEvent(e);
    } catch (e) {
      if (gen !== this.generation) return;
      this.state = "idle";
      this.thenOriginal = false;
      this.say(t(message(e)), true);
    }
  }

  /** Summarizes `raw` on `server` (omp there, the chosen model), then reads the summary. */
  async summarize(raw: string, server: string | undefined) {
    const plain = speakable(raw);
    if (!plain) return this.say(t("Nichts zum Vorlesen markiert."));
    if (!server) return this.say(t("Zusammenfassen geht nur im Chat oder Terminal einer Sitzung."), true);
    this.stop();
    const gen = ++this.generation;
    this.reading = { original: raw, server, summary: null, model: speech.summary.model, showing: "summary", error: "" };
    const reading = this.reading;
    this.state = "summarizing";
    this.lang = this.request(plain).lang;
    this.notice = "";
    try {
      // the model reads the selection as it is (Markdown and all), the voice reads its plain sentences
      const made = await summaryOf(server, raw, this.lang);
      if (gen !== this.generation) return;
      reading.summary = made.summary;
      reading.model = made.model;
      await this.play(made.summary, speech.summary.thenOriginal);
    } catch (e) {
      if (gen !== this.generation) return;
      this.state = "idle";
      reading.showing = "original";
      reading.error = summaryError(e);
    }
  }

  /** The panel's "Original vorlesen" */
  readOriginal() {
    const r = this.reading;
    if (!r) return;
    r.showing = "original";
    void this.play(r.original);
  }

  /** The panel's "Zusammenfassung vorlesen": the one made already, else a new one */
  readSummary() {
    const r = this.reading;
    if (r?.summary) {
      r.showing = "summary";
      void this.play(r.summary);
    } else if (r) void this.summarize(r.original, r.server);
  }

  /** The panel's "Nochmal": what it shows, from the start */
  again() {
    if (this.reading?.showing === "summary") this.readSummary();
    else this.readOriginal();
  }

  /** Stops and closes the panel. */
  close() {
    this.stop();
    this.reading = null;
  }

  /** No backend (dev bridge in a browser): log what would be read and show the controls for a while. */
  private preview(text: string, lang: SpeechLang) {
    if (!viaBridge) {
      this.state = "idle";
      return;
    }
    console.info(`[speech] (${lang}, ${speech.speed}×) ${text}`);
    this.engine = { engine: "system", label: t("Vorschau ohne Ton") };
    this.state = "speaking";
    const gen = this.generation;
    const done = () => {
      if (gen !== this.generation) return;
      this.state = "idle";
      this.finished();
    };
    this.previewTimer = setTimeout(done, Math.min(20_000, 1500 + text.length * 55));
  }

  stop() {
    if (!this.busy) return;
    this.generation++;
    clearTimeout(this.previewTimer);
    this.session = null;
    this.thenOriginal = false;
    // stopped while summarizing: nothing to show but the original
    if (this.reading?.showing === "summary" && !this.reading.summary) this.reading.showing = "original";
    this.state = "idle";
    invoke("speech_stop").catch(() => {});
  }
}

export const speaker = new Speaker();
