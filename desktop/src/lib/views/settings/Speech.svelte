<script lang="ts">
  // Settings → Vorlesen: what speaks which language (with a test per language), the engine, Phonon models
  // (download / choose / delete), the Hugging Face token for the gated ones, a voice per language, the
  // speed and the button next to selected text. Everything runs on this computer.
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { t } from "$lib/i18n";
  import {
    cancelPhonon, deletePhonon, downloadPhonon, downloadVoice, LANG_NAMES, loadVoices, localModel, modelPage, PHONON_MODELS,
    refreshSpeech, saveToken, speaker, speech, speechState, TOKEN_PAGE, type CatalogVoice,
  } from "$lib/speech.svelte";
  import { SAMPLES, SPEECH_LANGS, type SpeechLang } from "$lib/speechText";

  const mac = navigator.platform.includes("Mac");
  const status = $derived(speechState.status);
  const chosen = $derived(PHONON_MODELS.find((m) => m.id === speech.model) ?? PHONON_MODELS[0]);
  const chosenLocal = $derived(localModel(speech.model));

  // what speaks depends on the engine and the chosen model: ask again when they change
  $effect(() => {
    void speech.engine;
    void speech.model;
    void refreshSpeech();
  });

  // ---- voices (Gradium's catalog; only for a downloaded model that takes them)
  let catalog = $state<{ voices: CatalogVoice[]; compatible: boolean } | null>(null);
  let voiceError = $state("");
  let voiceBusy = $state<SpeechLang | "">("");
  $effect(() => {
    if (!chosenLocal) return;
    loadVoices()
      .then((c) => (catalog = c))
      .catch((e) => (voiceError = t(String(e))));
  });
  const voiceLangs = $derived(SPEECH_LANGS.filter((l) => chosenLocal?.languages.includes(l)));

  async function pickVoice(l: SpeechLang, name: string) {
    voiceError = "";
    const v = catalog?.voices.find((x) => x.name === name);
    if (v && !v.local) {
      voiceBusy = l;
      try {
        await downloadVoice(name);
        v.local = true;
      } catch (e) {
        voiceError = t(String(e));
        return;
      } finally {
        voiceBusy = "";
      }
    }
    speech.voices[l] = name;
  }

  // ---- token
  let token = $state("");
  let tokenError = $state("");
  async function storeToken(value: string) {
    tokenError = "";
    try {
      await saveToken(value);
      token = "";
    } catch (e) {
      tokenError = t(String(e));
    }
  }

  function engineText(l: SpeechLang) {
    const e = status?.engines[l];
    if (!status) return t("Nur in der App");
    if (!e) return t("Nichts verfügbar");
    if (e.engine === "phonon") return PHONON_MODELS.find((m) => m.id === e.label)?.name ?? e.label ?? "Phonon";
    return e.label ? `${t("Systemstimme")} · ${e.label}` : t("Systemstimme");
  }

  function test(l: SpeechLang) {
    if (speaker.busy) speaker.stop();
    else void speaker.speak(SAMPLES[l]);
  }

  const open = (url: string) => openUrl(url).catch(() => window.open(url, "_blank"));
</script>

<div class="page">
  <h1>{t("Vorlesen")}</h1>

  <div class="section">{t("Wer liest vor")}</div>
  <div class="rows">
    {#each SPEECH_LANGS as l (l)}
      <div class="row">
        <span class="lang">{t(LANG_NAMES[l])}</span>
        <span class="grow small" class:muted={status?.engines[l]?.engine !== "phonon"}>
          {#if status?.engines[l]?.engine === "phonon"}<span class="pill on">Phonon</span>{/if}
          {engineText(l)}
        </span>
        <button class="ic" disabled={!status?.engines[l] && !!status} title={speaker.busy ? t("Vorlesen stoppen (Esc)") : t("Probe anhören")}
          aria-label={speaker.busy ? t("Vorlesen stoppen (Esc)") : t("Probe anhören")} onclick={() => test(l)}>
          {speaker.busy ? "■" : "▶"}
        </button>
      </div>
    {/each}
  </div>
  <p class="foot">
    {t("Text im Chat oder Terminal markieren und auf „Vorlesen“ klicken oder {key} drücken; Esc stoppt. Die Sprache erkennt Hollr am Text, Code-Blöcke werden übersprungen.", { key: mac ? "⌘⇧S" : "Ctrl+Shift+S" })}
  </p>

  <div class="section">{t("Sprach-Engine")}</div>
  <div class="rows">
    <label class="row">
      <input type="radio" name="engine" value="auto" bind:group={speech.engine} />
      <span class="grow">
        {t("Automatisch")}
        <div class="small muted">{t("Phonon, wenn ein geladenes Modell die Sprache spricht – sonst die Systemstimme.")}</div>
      </span>
    </label>
    <label class="row" class:dimmed={status && !status.system}>
      <input type="radio" name="engine" value="system" bind:group={speech.engine} disabled={!!status && !status.system} />
      <span class="grow">
        {t("Immer die Systemstimme")}
        <div class="small muted">{status && !status.system ? t("Nur auf dem Mac (say).") : t("macOS-Stimmen (say), ohne Download.")}</div>
      </span>
    </label>
  </div>

  <div class="section">{t("Phonon-Modelle")}</div>
  <div class="rows">
    {#each PHONON_MODELS as m (m.id)}
      {@const local = localModel(m.id)}
      {@const progress = speechState.progress[m.id]}
      {@const selected = speech.model === m.id}
      <div class="row">
        <span class="grow">
          {m.name}
          <span class="pill">{m.gated ? "CC BY-NC 4.0" : "Apache 2.0"}</span>
          {#if selected && !local}<span class="pill">{t("gewählt")}</span>{/if}
          <div class="small muted">{local ? `${Math.round(local.bytes / 1e6)} MB` : m.size} · {t(m.note)}</div>
          {#if speechState.errors[m.id]}<div class="small warn">{speechState.errors[m.id]}</div>{/if}
        </span>
        <button class="ic" title={t("Modellseite auf Hugging Face")} aria-label={t("Modellseite auf Hugging Face")} onclick={() => open(modelPage(m.id))}>↗</button>
        {#if progress !== undefined}
          <progress value={progress} max="1"></progress>
          <span class="small muted pct">{Math.round(progress * 100)} %</span>
          <button class="ic" title={t("Download abbrechen")} aria-label={t("Download abbrechen")} onclick={() => cancelPhonon(m.id)}>✕</button>
        {:else if local}
          {#if selected}
            <span class="ok" title={t("Gewählt")}>✓</span>
          {:else}
            <button class="btn" onclick={() => (speech.model = m.id)}>{t("Wählen")}</button>
          {/if}
          <button class="ic del" title={t("Löschen")} aria-label={t("Löschen")} onclick={() => deletePhonon(m.id)}>🗑</button>
        {:else}
          <button class="btn" disabled={!status} onclick={() => { speech.model = m.id; void downloadPhonon(m.id); }}>↓ {t("Laden")}</button>
        {/if}
      </div>
    {/each}
  </div>
  <p class="foot">
    {t("Phonon von Gradium läuft auf diesem Computer (CPU, etwa 20× schneller als Echtzeit) und streamt, während es liest. Die Modelle liegen im App-Ordner.")}
  </p>

  <div class="section">{t("Hugging-Face-Zugang")}</div>
  <div class="rows">
    {#if status?.token}
      <div class="row">
        <span class="grow">{t("Token gespeichert")} <span class="ok">✓</span></span>
        <button class="btn" onclick={() => storeToken("")}>{t("Entfernen")}</button>
      </div>
    {:else}
      <form class="row" onsubmit={(e) => { e.preventDefault(); void storeToken(token); }}>
        <input class="grow mono" type="password" placeholder="hf_…" autocomplete="off" spellcheck="false" bind:value={token} disabled={!status} />
        <button class="btn" type="submit" disabled={!token.trim()}>{t("Speichern")}</button>
      </form>
    {/if}
  </div>
  {#if tokenError}<p class="foot warn">{tokenError}</p>{/if}
  <p class="foot">
    {t("Phonon 40m ist frei für nicht-kommerzielle Nutzung (CC BY-NC 4.0) und auf Hugging Face freigabepflichtig:")}
    <button class="link" onclick={() => open(modelPage(chosen.gated ? chosen.id : "phonon-40m-multilingual"))}>{t("1. Modellseite öffnen, anmelden und die Bedingungen akzeptieren")}</button>,
    <button class="link" onclick={() => open(TOKEN_PAGE)}>{t("2. einen Token mit Leserecht anlegen")}</button>,
    {t("3. hier eintragen und das Modell laden. Der Token bleibt auf diesem Computer (App-Ordner, nur für dich lesbar).")}
    {t("Phonon 31m (nur Englisch) braucht keinen Token.")}
  </p>

  {#if chosenLocal}
    <div class="section">{t("Stimme ({model})", { model: chosen.name })}</div>
    <div class="rows">
      {#each voiceLangs as l (l)}
        <label class="row">
          <span class="grow">{t(LANG_NAMES[l])}</span>
          {#if voiceBusy === l}<span class="spin"></span>{/if}
          <select value={speech.voices[l] ?? ""} disabled={!!voiceBusy} onchange={(e) => pickVoice(l, e.currentTarget.value)}>
            <option value="">{t("Standard (Modellstimme)")}</option>
            {#if catalog?.compatible}
              {#each catalog.voices.filter((v) => v.language === l) as v (v.name)}
                <option value={v.name}>{v.name}{v.gender ? ` · ${t(v.gender === "female" ? "weiblich" : "männlich")}` : ""}{v.locale ? ` · ${v.locale}` : ""}{v.local ? "" : " ↓"}</option>
              {/each}
            {/if}
          </select>
        </label>
      {/each}
    </div>
    {#if voiceError}<p class="foot warn">{voiceError}</p>{/if}
    <p class="foot">
      {catalog && !catalog.compatible ? t("Dieses Modell nimmt keine Stimmen aus Gradiums Katalog – es liest mit seiner eigenen.")
        : t("Stimmen aus Gradiums Katalog (gradium/phonon-voices), je ca. 250 KB, werden beim Wählen geladen.")}
    </p>
  {/if}

  <div class="section">{t("Allgemein")}</div>
  <div class="rows">
    <label class="row">
      <span class="grow">
        {t("Tempo")}
        {#if chosenLocal && !chosenLocal.speed}<div class="small muted">{t("Dieses Phonon-Modell liest immer im eigenen Tempo.")}</div>{/if}
      </span>
      <input type="range" min="0.8" max="1.3" step="0.05" bind:value={speech.speed} />
      <span class="num">{speech.speed.toFixed(2)}×</span>
    </label>
    <label class="row">
      <span class="grow">{t("Knopf „Vorlesen“ bei markiertem Text")}</span>
      <input type="checkbox" class="toggle" bind:checked={speech.button} />
    </label>
  </div>
</div>

<style>
  .foot { color: var(--dim); font-size: 12px; margin: 6px 4px 0; }
  .warn { color: var(--red); }
  .small { font-size: 12px; }
  .lang { width: 110px; flex: none; }
  .pill.on { background: color-mix(in srgb, var(--accent) 22%, transparent); color: var(--fg); }
  .ok { color: var(--green); font-weight: 600; }
  .dimmed { color: var(--dim); }
  progress { width: 90px; accent-color: var(--accent); }
  .pct { width: 38px; text-align: right; }
  .ic { all: unset; cursor: pointer; width: 26px; height: 26px; display: grid; place-items: center; border-radius: 6px; color: var(--muted); }
  .ic:hover:not(:disabled) { background: color-mix(in srgb, var(--fg) 8%, transparent); color: var(--fg); }
  .ic:disabled { opacity: .3; cursor: default; }
  .ic.del:hover { color: var(--red); }
  .num { min-width: 42px; text-align: right; font-variant-numeric: tabular-nums; }
  label.row { cursor: pointer; }
  select { padding: 4px 8px; max-width: 260px; }
  .row input:not(.toggle):not([type="radio"]):not([type="range"]) { padding: 5px 9px; }
  input[type="range"] { width: 160px; accent-color: var(--accent); }
  .link { all: unset; cursor: pointer; color: var(--accent); }
  .link:hover { text-decoration: underline; }
  .spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--border); border-top-color: var(--accent);
    animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
