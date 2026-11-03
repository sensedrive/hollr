<script lang="ts">
  // "Live läuft hier": the small 〰 on the server tab, the session's tab and its space in the sidebar while an
  // omp /live call runs there – pulsing in the live color, dimmed while the microphone is muted.
  import { t } from "$lib/i18n";
  import { findPane } from "$lib/store.svelte";
  import { live, liveActive, micMuted } from "$lib/live.svelte";

  /** shown for the call on that server – narrowed to one pane or to one workspace (space) when given */
  let { server, pane, ws }: { server: string; pane?: string; ws?: string } = $props();

  const here = $derived(
    liveActive() && live.server === server &&
      (pane === undefined || live.pane === pane) &&
      (ws === undefined || findPane(live.server, live.pane)?.workspace.id === ws),
  );
  const muted = $derived(micMuted());
  const title = $derived(
    live.phase === "connecting" ? t("Live verbindet …") : muted ? t("Live läuft – Mikrofon stumm") : t("Live läuft hier"),
  );
</script>

{#if here}
  <span class="live" class:muted class:connecting={live.phase !== "live"} {title} aria-label={title}>〰</span>
{/if}

<style>
  .live { --c: var(--green); flex: none; align-self: center; padding: 0 5px; border-radius: 8px; font-size: 11px; font-weight: 700;
    line-height: 15px; color: var(--c); background: color-mix(in srgb, var(--c) 24%, transparent); animation: pulse 1.6s ease-in-out infinite; }
  .live.connecting { --c: var(--accent); }
  .live.muted { --c: var(--dim); animation: none; }
  @keyframes pulse { 50% { background: color-mix(in srgb, var(--c) 8%, transparent); } }
</style>
