<script lang="ts">
  // Settings → Vorlesen: what speaks which language (with a test per language), the engine, Phonon models
  // from Ollama's registry (download / choose / delete, licence and source), a voice per language, the
  // speed and the button next to selected text – all on this computer. The spoken summary is the one
  // part made on a server: its omp model (the account it is logged in with shows), length and a test.
  import { openUrl } from "@tauri-apps/plugin-opener";
  import * as api from "$lib/api";
  import { lang as uiLang, t } from "$lib/i18n";
  import {
    cancelPhonon, deletePhonon, downloadPhonon, LANG_NAMES, loadVoices, localModel, modelPage, PHONON_MODELS,
    refreshSpeech, shortModel, SPEED, speaker, speech, speechState, summaryError, summaryOf, type ModelVoice,
  } from "$lib/speech.svelte";
  import { SAMPLES, SPEECH_LANGS, SUMMARY_SAMPLES, type SpeechLang } from "$lib/speechText";
  import { app, serverById } from "$lib/store.svelte";
  import { providerName, refreshUsage, usage } from "$lib/views/dashboard/usage.svelte";

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

  // ---- voices: baked into the downloaded model, described by Gradium's catalog
  let voices = $state<{ voices: ModelVoice[]; defaults: Partial<Record<SpeechLang, string>> } | null>(null);
  let voiceError = $state("");
  $effect(() => {
    if (!chosenLocal) return;
    loadVoices()
      .then((v) => (voices = v))
      .catch((e) => (voiceError = t(String(e))));
  });
  const voiceLangs = $derived(SPEECH_LANGS.filter((l) => chosenLocal?.languages.includes(l)));

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

  // ---- spoken summary: the servers with omp, the chosen one's models and the accounts behind them
  let ompServers = $state<string[] | null>(null);
  $effect(() => {
    const ids = app.servers.map((s) => s.id);
    Promise.all(ids.map((id) => api.kinds(id).then((k) => (k.includes("omp") ? id : "")).catch(() => "")))
      .then((found) => (ompServers = found.filter(Boolean)));
  });
  const summaryServer = $derived(
    ompServers?.includes(speech.summary.server) ? speech.summary.server : (ompServers?.[0] ?? ""),
  );
  let ompModels = $state<api.ModelList | null>(null);
  let modelsError = $state("");
  $effect(() => {
    const server = summaryServer;
    ompModels = null;
    modelsError = "";
    if (!server) return;
    api.models(server, "omp")
      .then((list) => server === summaryServer && (ompModels = list))
      .catch((e) => server === summaryServer && (modelsError = t(e instanceof Error ? e.message : String(e))));
    void refreshUsage();
  });
  const modelGroups = $derived.by(() => {
    const groups = new Map<string, api.ModelList["models"]>();
    for (const m of ompModels?.models ?? []) groups.set(m.group, [...(groups.get(m.group) ?? []), m]);
    return [...groups];
  });
  /** what a summary uses: the chosen model, else the server's fast one */
  const usedModel = $derived(speech.summary.model || ompModels?.fast || "");
  const usedGroup = $derived(ompModels?.models.find((m) => m.id === usedModel)?.group ?? usedModel.split("/")[0] ?? "");
  const accounts = $derived([
    ...new Set((usage.limits[summaryServer] ?? []).filter((l) => l.provider === usedGroup && l.account).map((l) => l.account)),
  ]);

  let summaryTest = $state<{ busy?: boolean; text?: string; model?: string; ms?: number; error?: string }>({});
  async function testSummary() {
    const started = performance.now();
    const lang = uiLang() === "en" ? "en" : "de";
    summaryTest = { busy: true };
    try {
      const made = await summaryOf(summaryServer, SUMMARY_SAMPLES[lang], lang);
      summaryTest = { text: made.summary, model: made.model, ms: performance.now() - started };
    } catch (e) {
      summaryTest = { error: summaryError(e) };
    }
  }
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

  <div class="section">{t("Zusammenfassung")}</div>
  <div class="rows">
    {#if (ompServers?.length ?? 0) > 1}
      <label class="row">
        <span class="grow">{t("Server (Modelle und Test)")}</span>
        <select value={summaryServer} onchange={(e) => (speech.summary.server = e.currentTarget.value)}>
          {#each ompServers ?? [] as id (id)}<option value={id}>{serverById(id)?.label ?? id}</option>{/each}
        </select>
      </label>
    {/if}
    <label class="row">
      <span class="grow">
        {t("Modell")}
        {#if usedModel}
          <div class="small muted">
            {t("Konto")}: {providerName(usedGroup)}{accounts.length ? ` · ${accounts.join(", ")}` : ""}
            {#if accounts.length > 1} · {t("omp wechselt zwischen diesen Konten")}{/if}
          </div>
        {/if}
      </span>
      <select value={speech.summary.model} disabled={!ompModels} onchange={(e) => (speech.summary.model = e.currentTarget.value)}>
        <option value="">{ompModels?.fast ? t("Automatisch ({name})", { name: shortModel(ompModels.fast) }) : t("Automatisch (schnelles Modell)")}</option>
        {#if speech.summary.model && ompModels && !ompModels.models.some((m) => m.id === speech.summary.model)}
          <option value={speech.summary.model}>{speech.summary.model} · {t("nicht auf diesem Server")}</option>
        {/if}
        {#each modelGroups as [group, list] (group)}
          <optgroup label={providerName(group)}>
            {#each list as m (m.id)}<option value={m.id}>{m.name}</option>{/each}
          </optgroup>
        {/each}
      </select>
    </label>
    <div class="row">
      <span class="grow">{t("Länge")}</span>
      <label class="choice"><input type="radio" name="summary-length" value="kurz" bind:group={speech.summary.length} /> {t("kurz (2–3 Sätze)")}</label>
      <label class="choice"><input type="radio" name="summary-length" value="mittel" bind:group={speech.summary.length} /> {t("mittel (5–7 Sätze)")}</label>
    </div>
    <label class="row">
      <span class="grow">
        {t("Zusammenfassung, danach Original")}
        <div class="small muted">{t("Liest nach der Zusammenfassung gleich den markierten Text vor.")}</div>
      </span>
      <input type="checkbox" class="toggle" bind:checked={speech.summary.thenOriginal} />
    </label>
    <div class="row">
      <span class="grow">
        {t("Probe")}
        <div class="small muted">{t("Fasst einen Beispieltext zusammen und zeigt das Ergebnis.")}</div>
      </span>
      <button class="btn" disabled={!summaryServer || summaryTest.busy} onclick={testSummary}>
        {summaryTest.busy ? t("Fasse zusammen …") : t("Testen")}
      </button>
    </div>
    {#if summaryTest.text}
      <div class="row result">
        <span class="grow">
          {summaryTest.text}
          <div class="small muted">{shortModel(summaryTest.model ?? "")} · {(summaryTest.ms ?? 0) < 50 ? t("aus dem Zwischenspeicher") : `${((summaryTest.ms ?? 0) / 1000).toFixed(1)} s`}</div>
        </span>
        <button class="ic" title={speaker.busy ? t("Vorlesen stoppen (Esc)") : t("Vorlesen")} aria-label={speaker.busy ? t("Vorlesen stoppen (Esc)") : t("Vorlesen")}
          onclick={() => (speaker.busy ? speaker.stop() : speaker.speak(summaryTest.text ?? ""))}>
          {speaker.busy ? "■" : "▶"}
        </button>
      </div>
    {/if}
  </div>
  {#if summaryTest.error || modelsError}<p class="foot warn">{summaryTest.error || modelsError}</p>{/if}
  {#if ompServers && !ompServers.length}<p class="foot warn">{t("Auf keinem Server ist omp installiert.")}</p>{/if}
  <p class="foot">
    {t("„Zusammenfassung“ neben markiertem Text oder {key}: omp fasst den Text auf dem Server der Sitzung zusammen – mit diesem Modell und dem Konto, mit dem omp dort angemeldet ist –, danach wird vorgelesen. Ohne Werkzeuge, ohne gespeicherte Sitzung.", { key: mac ? "⌘⌥⇧S" : "Ctrl+Alt+Shift+S" })}
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
          <span class="pill">{m.license}</span>
          {#if selected && !local}<span class="pill">{t("gewählt")}</span>{/if}
          <div class="small muted">{local ? `${Math.round(local.bytes / 1e6)} MB` : m.size} · {t(m.note)}</div>
          {#if local?.attribution}<div class="small muted">{local.attribution}</div>{/if}
          {#if speechState.errors[m.id]}
            <div class="small warn">{speechState.errors[m.id]} · {t("„Laden“ macht dort weiter.")}</div>
          {/if}
        </span>
        <button class="ic" title={t("Modellseite in der Ollama-Registry")} aria-label={t("Modellseite in der Ollama-Registry")} onclick={() => open(modelPage(m.id))}>↗</button>
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
    {t("Phonon von Gradium läuft auf diesem Computer (CPU, etwa 20× schneller als Echtzeit) und streamt, während es liest.")}
    {t("Quelle: Ollama-Registry (library/phonon), ohne Anmeldung. Die Modelle stammen von Gradium – Phonon 40m unter CC BY-NC 4.0 (nur nicht-kommerziell), Phonon 31m unter Apache 2.0; die Lizenztexte liegen beim Modell im App-Ordner.")}
  </p>

  {#if chosenLocal}
    <div class="section">{t("Stimme ({model})", { model: chosen.name })}</div>
    <div class="rows">
      {#each voiceLangs as l (l)}
        <label class="row">
          <span class="grow">{t(LANG_NAMES[l])}</span>
          <select value={speech.voices[l] ?? ""} onchange={(e) => (speech.voices[l] = e.currentTarget.value)}>
            <option value="">{voices?.defaults[l] ? t("Standard ({name})", { name: voices.defaults[l] }) : t("Standard")}</option>
            {#each voices?.voices.filter((v) => v.language === l || !v.language) ?? [] as v (v.name)}
              <option value={v.name}>{v.name}{v.gender ? ` · ${t(v.gender === "female" ? "weiblich" : "männlich")}` : ""}{v.locale ? ` · ${v.locale}` : ""}</option>
            {/each}
          </select>
        </label>
      {/each}
    </div>
    {#if voiceError}<p class="foot warn">{voiceError}</p>{/if}
    <p class="foot">{t("Die Stimmen aus Gradiums Katalog sind im Modell enthalten – kein weiterer Download.")}</p>
  {/if}

  <div class="section">{t("Allgemein")}</div>
  <div class="rows">
    <label class="row">
      <span class="grow">
        {t("Tempo")}
        {#if chosenLocal && !chosenLocal.speed}
          <div class="small muted">{t("Dieses Phonon-Modell liest immer im eigenen Tempo.")}</div>
        {:else}
          <div class="small muted">{t("Phonon liest etwa zwischen 0,8× und 1,3×, die Systemstimme im ganzen Bereich.")}</div>
        {/if}
      </span>
      <input type="range" min={SPEED.min} max={SPEED.max} step="0.05" bind:value={speech.speed} />
      <span class="num">{speech.speed.toFixed(2)}×</span>
    </label>
    <label class="row">
      <span class="grow">{t("Knöpfe „Vorlesen“ und „Zusammenfassung“ bei markiertem Text")}</span>
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
  input[type="range"] { width: 160px; accent-color: var(--accent); }
  .choice { display: flex; align-items: center; gap: 5px; margin-left: 12px; font-size: 12.5px; cursor: pointer; }
  .result .grow { line-height: 1.45; }
</style>
