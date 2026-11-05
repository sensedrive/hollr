<script lang="ts">
  import Icon from "$lib/components/git/Icon.svelte";
  // The running omp /live call while its session isn't on screen (sidebar, above Einstellungen): state, mic,
  // hang up – a click leads back to the session.
  import { t } from "../i18n";
  import { nav, openAgent, serverById } from "../store.svelte";
  import {
    live, liveActive, liveColor, liveDetail, liveTitle, micMuted, reconnectLive, stopLive, toggleLiveMic,
  } from "../live.svelte";

  const viewing = $derived(nav.route.view === "agent" && nav.route.server === live.server && nav.route.pane === live.pane);
  const shown = $derived(!!live.server && !viewing && (liveActive() || live.phase === "lost" || !!live.error));
  const serverLabel = $derived(serverById(live.server)?.label ?? live.server);
  const detail = $derived(live.phase === "" ? live.error : live.audioError ? live.audioError : liveDetail());

  const open = () => openAgent(live.server, live.pane);
</script>

{#if shown}
  <div class="pill" style:--live={live.phase === "" ? "var(--red)" : liveColor()}>
    <button class="go" title={t("Zur Sitzung „{name}“ ({server})", { name: live.label || live.pane, server: serverLabel })}
      onclick={open}>
      <span class="dot" class:pulse={live.phase === "live" && !micMuted()}></span>
      <span class="text">
        <b>{live.phase ? liveTitle() : t("Live beendet")} · {live.label || live.pane}</b>
        <span class="state">{detail}</span>
      </span>
    </button>
    {#if live.phase === "live"}
      <button class="b" class:warn={micMuted()} title={micMuted() ? t("Mikrofon an") : t("Mikrofon aus (wie Leertaste) – du hörst weiter zu")}
        onclick={toggleLiveMic}><Icon name={micMuted() ? "mic-off" : "mic"} size={14} /></button>
    {:else if live.phase === "lost"}
      <button class="b" title={t("Neu verbinden")} aria-label={t("Neu verbinden")} onclick={reconnectLive}><Icon name="↻" size={15} /></button>
    {/if}
    <button class="b" class:hang={liveActive()} title={liveActive() ? t("Live beenden") : t("Schließen")}
      aria-label={liveActive() ? t("Live beenden") : t("Schließen")} onclick={stopLive}><Icon name="✕" size={15} /></button>
  </div>
{/if}

<style>
  .pill { display: flex; align-items: center; gap: 4px; margin-bottom: 6px; padding: 5px 5px 5px 4px; border-radius: 10px;
    background: color-mix(in srgb, var(--live) 14%, var(--card)); border: 1px solid color-mix(in srgb, var(--live) 40%, transparent); }
  .go { all: unset; cursor: pointer; flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; padding: 2px 4px; border-radius: 7px; }
  .go:hover { background: color-mix(in srgb, var(--fg) 6%, transparent); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--live); flex: none; }
  .dot.pulse { animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--live) 25%, transparent); } }
  .text { display: grid; min-width: 0; line-height: 1.3; }
  .text b, .state { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .text b { font-size: 12.5px; }
  .state { font-size: 11.5px; color: var(--live); }
  .b { all: unset; cursor: pointer; width: 26px; height: 26px; display: grid; place-items: center; border-radius: 50%; flex: none; font-size: 12px;
    background: color-mix(in srgb, var(--fg) 10%, transparent); }
  .b:hover { background: color-mix(in srgb, var(--fg) 18%, transparent); }
  .b.warn { background: var(--orange); }
  .b.hang { background: var(--red); color: #fff; }
</style>
