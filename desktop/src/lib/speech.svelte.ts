// Read aloud: settings in localStorage, the Phonon models / voices / token (speech.rs), the selection on
// offer (chat or terminal, ReadAloud.svelte shows the button) and the one thing the app reads at a time.
// Cleanup and language detection: speechText.ts. The Hugging Face token lives in Rust (app data, 0600) –
// the webview only learns whether one is saved.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { lang as uiLang, t } from "./i18n";
import { detectLanguage, speakable, type SpeechLang } from "./speechText";

const KEY = "hollr.speech";

export interface SpeechSettings {
  /** "auto": Phonon when a downloaded model speaks the language, else the system voice; "system": always the system voice */
  engine: "auto" | "system";
  /** the preferred Phonon model (PHONON_MODELS id) */
  model: string;
  /** Phonon voice per language ("" = the model's own) */
  voices: Partial<Record<SpeechLang, string>>;
  /** 0.8 … 1.3 (Phonon: duration_delta, system voice: words per minute) */
  speed: number;
  /** the "Vorlesen" button next to selected text */
  button: boolean;
}

const defaults: SpeechSettings = { engine: "auto", model: "phonon-40m-multilingual", voices: {}, speed: 1, button: true };

function load(): SpeechSettings {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { ...defaults };
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
  size: string;
  languages: SpeechLang[];
  /** CC BY-NC: terms on Hugging Face + a read token */
  gated: boolean;
  note: string;
}

export const PHONON_MODELS: PhononModel[] = [
  { id: "phonon-40m-multilingual", name: "Phonon 40m multilingual", size: "75 MB", languages: ["de", "en", "fr", "es", "pt"], gated: true,
    note: "Deutsch, Englisch, Französisch, Spanisch, Portugiesisch – empfohlen" },
  { id: "phonon-40m-de", name: "Phonon 40m de", size: "75 MB", languages: ["de"], gated: true, note: "Nur Deutsch" },
  { id: "phonon-40m-en", name: "Phonon 40m en", size: "75 MB", languages: ["en"], gated: true, note: "Nur Englisch" },
  { id: "phonon-31m-en", name: "Phonon 31m en", size: "65 MB", languages: ["en"], gated: false,
    note: "Nur Englisch, frei (Apache 2.0) – ohne Token" },
];

export const modelPage = (id: string) => `https://huggingface.co/gradium/${id}`;
export const TOKEN_PAGE = "https://huggingface.co/settings/tokens";
export const LANG_NAMES: Record<SpeechLang, string> = { de: "Deutsch", en: "Englisch", fr: "Französisch", es: "Spanisch", pt: "Portugiesisch" };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** the dev bridge (normal browser) has no audio: speaking is only logged and shown */
const viaBridge = new URLSearchParams(location.search).has("bridge");

// ------------------------------------------------------------ models, token, voices

type LocalModel = { id: string; bytes: number; languages: string[]; speed: boolean; catalog_voices: boolean };
type EngineInfo = { engine: "phonon" | "system"; label: string | null };
type Status = { system: boolean; token: boolean; models: LocalModel[]; engines: Record<string, EngineInfo | null> };
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

/** "" removes the token */
export async function saveToken(token: string) {
  await invoke("speech_token", { token });
  await refreshSpeech();
}

export type CatalogVoice = { name: string; language: string | null; locale: string | null; gender: string | null; description: string | null; local: boolean };

/** Gradium's voice catalog; `compatible` = the chosen model takes these voices */
export async function loadVoices(): Promise<{ voices: CatalogVoice[]; compatible: boolean } | null> {
  return await invoke<{ voices: CatalogVoice[]; compatible: boolean } | null>("speech_voices", { model: speech.model });
}

export async function downloadVoice(name: string) {
  await invoke("speech_voice_download", { name });
}

refreshSpeech();

// ------------------------------------------------------------ the selection on offer

export type Source = "chat" | "terminal";
export interface Offer {
  text: string;
  source: Source;
  /** where the button goes (viewport px) */
  x: number;
  y: number;
}

/** selected text that can be read (one at a time: the last selection made) */
export const selection = $state<{ offer: Offer | null }>({ offer: null });

export function offerSelection(offer: Offer) {
  selection.offer = offer;
  speaker.prewarm(offer.text);
}

/** `source` let go of its selection */
export function withdrawSelection(source: Source) {
  if (selection.offer?.source === source) selection.offer = null;
}

// ------------------------------------------------------------ the speaker

type SpeechEvent = { session: number; t: "playing" | "end" | "error"; error?: string; warning?: string | null };
type Started = { session: number } & EngineInfo;
type Phase = "idle" | "loading" | "speaking";

/** One voice in the whole app: a new request stops the old one. */
class Speaker {
  state = $state<Phase>("idle");
  /** what speaks: "phonon" | "system" (and the model / voice) */
  engine = $state<EngineInfo | null>(null);
  lang = $state<SpeechLang>("de");
  /** the last error / warning, shown for a few seconds */
  notice = $state("");
  failed = $state(false);

  private session: number | null = null;
  private early: SpeechEvent[] = [];
  private generation = 0;
  private events: Promise<unknown> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private previewTimer: ReturnType<typeof setTimeout> | undefined;
  private warmed = "";

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
    }
  }

  /** Loads the model the next request would need (text got selected), so it starts right away. */
  prewarm(raw: string) {
    const r = this.request(speakable(raw));
    const key = `${r.lang}|${r.engine}|${r.model}|${r.speed}`;
    if (!r.text || key === this.warmed) return;
    this.warmed = key;
    invoke("speech_prewarm", { request: r }).catch(() => {});
  }

  async speak(raw: string) {
    const text = speakable(raw);
    if (!text) return this.say(t("Nichts zum Vorlesen markiert."));
    const gen = ++this.generation;
    const r = this.request(text);
    clearTimeout(this.previewTimer);
    this.state = "loading";
    this.lang = r.lang;
    this.notice = "";
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
      this.say(t(message(e)), true);
    }
  }

  /** No backend (dev bridge in a browser): log what would be read and show the controls for a while. */
  private preview(text: string, lang: SpeechLang) {
    if (!viaBridge) {
      this.state = "idle";
      return;
    }
    console.info(`[speech] (${lang}) ${text}`);
    this.engine = { engine: "system", label: t("Vorschau ohne Ton") };
    this.state = "speaking";
    const gen = this.generation;
    this.previewTimer = setTimeout(() => gen === this.generation && (this.state = "idle"), Math.min(20_000, 1500 + text.length * 55));
  }

  stop() {
    if (!this.busy) return;
    this.generation++;
    clearTimeout(this.previewTimer);
    this.session = null;
    this.state = "idle";
    invoke("speech_stop").catch(() => {});
  }
}

export const speaker = new Speaker();
