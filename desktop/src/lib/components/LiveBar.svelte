<script lang="ts">
  import Icon from "$lib/components/git/Icon.svelte";
  // The live call's bar for one pane (omp /live, live.svelte.ts): level bars, what omp does, speaker / mic /
  // hang up – or "Neu verbinden" after a lost connection – plus the call's error or last note. Nothing while
  // the app-wide call isn't about this pane. Shown in the session's composer.
  import { t } from "../i18n";
  import {
    live, liveAbout, liveActive, liveColor, liveDetail, liveTitle, reconnectLive, stopLive, toggleLiveMic, toggleLiveSpeaker,
  } from "../live.svelte";

  let { server, pane }: { server: string; pane: string } = $props();

  /** the store's call (or its last error / note) is this pane's */
  const mine = $derived(liveAbout(server, pane));
  const phase = $derived(mine ? live.phase : "");
  const micMuted = $derived(mine && live.ompState === "muted");
  const speakerMuted = $derived(mine && live.speakerMuted);
  const levels = $derived(mine ? live.levels : { input: 0, output: 0 });
  const color = $derived(mine ? liveColor() : "var(--accent)");
</script>

{#if phase}
  <div class="live" style:--live={color} title={live.devices}>
    <div class="bars">{#each [0.45, 0.8, 1, 0.7, 0.4] as w}<span style:height="{6 + 22 * w * Math.min(1, micMuted ? 0 : Math.max(levels.input * 6, levels.output * 4))}px"></span>{/each}</div>
    <div class="grow">
      <b>{liveTitle()}</b>
      <div class="small livestate">{liveDetail()}</div>
    </div>
    {#if phase === "lost"}
      <button class="relive" onclick={reconnectLive}>{t("Neu verbinden")}</button>
      <button class="round" title={t("Schließen")} aria-label={t("Schließen")} onclick={stopLive}><Icon name="✕" size={15} /></button>
    {:else}
      <button class="round" class:warn={speakerMuted} disabled={phase !== "live"} title={speakerMuted ? t("Ton an") : t("Ton aus (Antwort nicht hören)")} onclick={toggleLiveSpeaker}><Icon name={speakerMuted ? "🔇" : "🔊"} size={13} /></button>
      <button class="round" class:warn={micMuted} disabled={phase !== "live"} title={micMuted ? t("Mikrofon an") : t("Mikrofon aus (wie Leertaste) – du hörst weiter zu")} onclick={toggleLiveMic}>{micMuted ? "🎙̸" : "🎙"}</button>
      <button class="round hang" title={t("Live beenden")} onclick={stopLive}><Icon name="✕" size={15} /></button>
    {/if}
  </div>
  {#if mine && liveActive() && live.audioError}<div class="err small"><Icon name="⚠" size={15} /> {live.audioError}</div>{/if}
{/if}
{#if mine && live.error && phase !== "lost"}<div class="err small">{live.error}</div>{/if}
{#if mine && live.note && !phase}<div class="muted small">{live.note}</div>{/if}

<style>
  .live { display: flex; align-items: center; gap: 12px; }
  .live b { font-size: 13.5px; }
  .livestate { color: var(--live); }
  .bars { display: flex; gap: 3px; align-items: center; width: 36px; height: 30px; flex: none; }
  .bars span { width: 4px; border-radius: 2px; background: var(--live); transition: height 0.1s; }
  .round { width: 34px; height: 34px; border-radius: 50%; border: 0; background: color-mix(in srgb, var(--fg) 10%, transparent); flex: none; }
  .round:disabled { opacity: 0.4; }
  .round.warn { background: var(--orange); }
  .round.hang { background: var(--red); color: #fff; }
  .relive { all: unset; cursor: pointer; height: 30px; padding: 0 12px; border-radius: 999px; font-size: 12.5px; font-weight: 600;
    color: var(--accent); background: color-mix(in srgb, var(--accent) 18%, transparent); flex: none; }
  .relive:hover { background: color-mix(in srgb, var(--accent) 28%, transparent); }
  .grow { flex: 1; min-width: 0; }
  .small { font-size: 12px; }
  .muted { color: var(--muted); }
  .err { color: var(--red); }
</style>
