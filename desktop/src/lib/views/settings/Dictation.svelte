<script lang="ts">
  import Icon from "$lib/components/git/Icon.svelte";
  // Settings → Diktat (iOS SpeechSettingsView): test recording, engine, Whisper models (download / choose /
  // delete), language and sending, text cleanup, vocabulary and fixed replacements. Everything runs locally.
  import { onDestroy, onMount } from "svelte";
  import { t } from "$lib/i18n";
  import { cancelDownload, deleteModel, dictation, dictator, downloadModel, models, refreshModels } from "$lib/dictation.svelte";
  import { DEFAULT_VOCABULARY, LANGUAGES, parseTerms, WHISPER_MODELS } from "$lib/dictationText";

  /** owner of the test dictation (no chat) */
  const OWNER = "settings";
  let testText = $state("");
  const testing = $derived(dictator.owner === OWNER);
  const recording = $derived(testing && dictator.state === "recording");
  const testDisplay = $derived(
    recording ? dictator.text || t("Ich höre zu … (zum Beenden klicken)")
      : testing && dictator.state === "transcribing" ? t("Transkribiere …")
      : testing && dictator.state === "preparing" ? t("Mikrofon startet …")
      : testText || t("Klicken, um eine Testtranskription aufzunehmen"),
  );
  const testNote = $derived(
    dictator.noticeFor === OWNER && !dictator.isBusy ? (dictator.state === "failed" ? dictator.error : dictator.notice) : "",
  );
  const termCount = $derived(parseTerms(dictation.vocabularyText).length);

  onMount(refreshModels);
  onDestroy(() => {
    if (dictator.owner === OWNER) dictator.cancel();
  });

  function test() {
    if (recording) return dictator.finish();
    testText = "";
    dictator.start(OWNER, [], (text) => (testText = text));
  }

  function addReplacement() {
    dictation.replacements.push({ id: crypto.randomUUID(), from: "", to: "" });
  }
</script>

<div class="page">
  <h1>{t("Diktat")}</h1>

  <div class="section">{t("Transkription testen")}</div>
  <div class="card test">
    <span class="grow" class:muted={!testText && !recording}>{testDisplay}</span>
    <button class="rec" class:on={recording} disabled={(dictator.isBusy && !testing) || (testing && !recording)} onclick={test}
      aria-label={recording ? t("Diktat beenden") : t("Diktieren")}>
      {#if testing && !recording}
        <span class="spin"></span>
      {:else if recording}
        <span class="sq"></span>
      {:else}
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
          <rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25" /><path d="M3.25 7.5a4.75 4.75 0 0 0 9.5 0M8 12.25v2" />
        </svg>
      {/if}
    </button>
  </div>
  {#if testNote}<p class="foot" class:warn={dictator.state === "failed"}>{testNote}</p>{/if}

  <div class="section">{t("Sprach-Engine")}</div>
  <div class="rows">
    <div class="row">
      <span class="grow">
        <b>Whisper</b> <span class="pill">whisper.cpp</span>
        <div class="small muted">{t("OpenAI, 99 Sprachen, läuft auf diesem Computer (auf dem Mac mit Metal-GPU)")}</div>
      </span>
      <span class="ok"><Icon name="✓" size={15} /></span>
    </div>
    <div class="row dimmed">
      <span class="grow">
        Parakeet · Apple
        <div class="small">{t("Nur in der iPhone-App – sie brauchen Apples Neural Engine bzw. die iOS-Spracherkennung.")}</div>
      </span>
    </div>
  </div>
  <p class="foot">{t("Alles bleibt auf diesem Computer – keine Audiodaten verlassen ihn. Large v3 ist am genauesten, braucht aber mehr Zeit und Speicher.")}</p>

  <div class="section">{t("Whisper-Modelle (mehrsprachig)")}</div>
  <div class="rows">
    {#each WHISPER_MODELS as m (m.id)}
      {@const downloaded = m.id in models.local}
      {@const progress = models.progress[m.id]}
      {@const selected = dictation.whisperModel === m.id}
      <div class="row">
        <span class="grow">
          {m.name}
          {#if selected && !downloaded}<span class="pill">{t("gewählt")}</span>{/if}
          <div class="small muted">{m.size} · {t(m.note)}</div>
          {#if models.errors[m.id]}<div class="small warn">{models.errors[m.id]}</div>{/if}
        </span>
        {#if progress !== undefined}
          <progress value={progress} max="1"></progress>
          <span class="small muted pct">{Math.round(progress * 100)} %</span>
          <button class="ic" title={t("Download abbrechen")} aria-label={t("Download abbrechen")} onclick={() => cancelDownload(m.id)}><Icon name="✕" size={15} /></button>
        {:else if downloaded}
          {#if selected}
            <span class="ok" title={t("Gewählt")}><Icon name="✓" size={15} /></span>
          {:else}
            <button class="btn" onclick={() => (dictation.whisperModel = m.id)}>{t("Wählen")}</button>
          {/if}
          <button class="ic del" title={t("Löschen")} aria-label={t("Löschen")} onclick={() => deleteModel(m.id)}><Icon name="🗑" size={15} /></button>
        {:else}
          <button class="btn" onclick={() => downloadModel(m.id)}>↓ {t("Laden")}</button>
        {/if}
      </div>
    {/each}
  </div>
  <p class="foot">{t("Die Modelle kommen von Hugging Face (ggerganov/whisper.cpp) und liegen im App-Ordner.")}</p>

  <div class="section">{t("Feintuning")}</div>
  <div class="rows">
    <div class="row">
      <span class="grow">{t("Wiederholungen bei Unsicherheit")}</span>
      <button class="ic" disabled={dictation.whisperFallbacks <= 0} onclick={() => dictation.whisperFallbacks--} aria-label="−">−</button>
      <span class="num">{dictation.whisperFallbacks}</span>
      <button class="ic" disabled={dictation.whisperFallbacks >= 5} onclick={() => dictation.whisperFallbacks++} aria-label="+">+</button>
    </div>
  </div>
  <p class="foot">{t("Mehr Wiederholungen = robuster bei schwierigen Stellen, aber langsamer.")}</p>

  <div class="section">{t("Allgemein")}</div>
  <div class="rows">
    <label class="row">
      <span class="grow">{t("Sprache")}</span>
      <select bind:value={dictation.language}>
        {#each LANGUAGES as l (l.code)}<option value={l.code}>{t(l.name)}</option>{/each}
      </select>
    </label>
    <label class="row">
      <span class="grow">{t("Nach dem Diktieren automatisch senden")}</span>
      <input type="checkbox" class="toggle" bind:checked={dictation.autoSend} />
    </label>
    <label class="row">
      <span class="grow">{t("„… senden“ am Ende schickt ab")}</span>
      <input type="checkbox" class="toggle" bind:checked={dictation.voiceSend} />
    </label>
  </div>
  <p class="foot">
    {t("Für Deutsch mit englischen Fachbegriffen „Deutsch“ wählen – das ist genauer als „Automatisch“.")}
    {t("Mikrofon klicken startet und beendet, gedrückt halten diktiert bis zum Loslassen. Aufgenommen wird mit dem Standard-Mikrofon des Systems.")}
  </p>

  <div class="section">{t("Text")}</div>
  <div class="rows">
    <label class="row">
      <span class="grow">{t("Wörter aus der offenen Session")}</span>
      <input type="checkbox" class="toggle" bind:checked={dictation.sessionVocabulary} />
    </label>
    <label class="row">
      <span class="grow">{t("Füllwörter entfernen („ähm“, „äh“)")}</span>
      <input type="checkbox" class="toggle" bind:checked={dictation.removeFillers} />
    </label>
  </div>
  <p class="foot">{t("Session-Wörter: Projekt, Ordner, Tickets (z. B. TENDR-725) und Dateinamen aus dem Chat helfen der Erkennung und werden richtig geschrieben.")}</p>

  <div class="section">{t("Fachwörter ({n})", { n: termCount })}</div>
  <div class="rows">
    <label class="row">
      <span class="grow">{t("Fachwörter verwenden")}</span>
      <input type="checkbox" class="toggle" bind:checked={dictation.useVocabulary} />
    </label>
    <div class="row vocab">
      <textarea class="mono" rows="10" spellcheck="false" bind:value={dictation.vocabularyText} disabled={!dictation.useVocabulary}></textarea>
    </div>
  </div>
  <p class="foot">
    {t("Ein Begriff pro Zeile, falsch verstandene Varianten nach „=“: z. B. „JIRA = Jira, Dschira“. Die Liste fließt in den Whisper-Prompt ein und korrigiert danach Schreibweisen.")}
    <button class="reset" onclick={() => (dictation.vocabularyText = DEFAULT_VOCABULARY)}>{t("Standardliste wiederherstellen")}</button>
  </p>

  <div class="section">{t("Wortersetzungen")}</div>
  <div class="rows">
    {#each dictation.replacements as r, i (r.id)}
      <div class="row">
        <input class="grow" bind:value={r.from} placeholder={t("gehört")} spellcheck="false" />
        <span class="muted">→</span>
        <input class="grow" bind:value={r.to} placeholder={t("ersetzen durch")} spellcheck="false" />
        <button class="ic del" title={t("Entfernen")} aria-label={t("Entfernen")} onclick={() => dictation.replacements.splice(i, 1)}><Icon name="✕" size={15} /></button>
      </div>
    {/each}
    <button class="row" onclick={addReplacement}><span class="grow"><Icon name="＋" size={15} /> {t("Ersetzung hinzufügen")}</span></button>
  </div>
  <p class="foot">{t("Feste Ersetzungen nach der Erkennung, z. B. „Komma“ → „,“.")}</p>
</div>

<style>
  .foot { color: var(--dim); font-size: 12px; margin: 6px 4px 0; }
  .warn { color: var(--red); }
  .small { font-size: 12px; }
  .test { display: flex; align-items: center; gap: 12px; min-height: 44px; }
  .rec { all: unset; cursor: pointer; flex: none; width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center;
    background: var(--red); color: #fff; font-size: 16px; }
  .rec:disabled { opacity: .5; cursor: default; }
  .rec.on { filter: brightness(1.1); }
  .sq { width: 12px; height: 12px; border-radius: 2px; background: #fff; }
  .spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid rgba(255, 255, 255, .35); border-top-color: #fff;
    animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .ok { color: var(--green); font-weight: 600; }
  .dimmed { color: var(--dim); }
  progress { width: 90px; accent-color: var(--accent); }
  .pct { width: 38px; text-align: right; }
  .ic { all: unset; cursor: pointer; width: 26px; height: 26px; display: grid; place-items: center; border-radius: 6px; color: var(--muted); }
  .ic:hover:not(:disabled) { background: color-mix(in srgb, var(--fg) 8%, transparent); color: var(--fg); }
  .ic:disabled { opacity: .3; cursor: default; }
  .ic.del:hover { color: var(--red); }
  .num { min-width: 18px; text-align: center; font-variant-numeric: tabular-nums; }
  label.row { cursor: pointer; }
  select { padding: 4px 8px; }
  .vocab textarea { width: 100%; resize: vertical; font-size: 12px; line-height: 1.5; }
  .vocab textarea:disabled { opacity: .5; }
  .row input:not(.toggle) { padding: 5px 9px; }
  .reset { all: unset; cursor: pointer; color: var(--accent); margin-left: 6px; }
  .reset:hover { text-decoration: underline; }
</style>
