<script lang="ts">
  // The dashboard's globe (DashboardView.swift › openInBrowser): the in-app browser for a server's web ports and
  // any address, without opening a session first.
  import BrowserPanel from "$lib/components/BrowserPanel.svelte";
  import { t } from "$lib/i18n";
  import { app } from "$lib/store.svelte";

  let { onClose }: { onClose: () => void } = $props();
  let server = $state(app.servers[0]?.id ?? "");
  const label = $derived(app.servers.find((s) => s.id === server)?.label ?? server);
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && onClose()} />

<div class="backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && onClose()}>
  <div class="win" role="dialog" aria-label={t("Browser")}>
    {#if app.servers.length > 1}
      <div class="servers">
        {#each app.servers as s (s.id)}
          <button class:on={server === s.id} onclick={() => (server = s.id)}>{s.label}</button>
        {/each}
      </div>
    {/if}
    {#key server}
      <div class="panel"><BrowserPanel {server} serverLabel={label} {onClose} /></div>
    {/key}
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 10; background: rgba(0, 0, 0, .5); display: grid; place-items: center; }
  .win { width: min(1100px, 92vw); height: 82vh; display: flex; flex-direction: column; background: var(--side); border: 1px solid var(--border);
    border-radius: 14px; overflow: hidden; }
  .servers { display: flex; gap: 2px; padding: 6px 8px; border-bottom: 1px solid var(--border); }
  .servers button { all: unset; cursor: pointer; padding: 3px 12px; border-radius: 6px; font-size: 12px; color: var(--muted); }
  .servers button.on { background: var(--card); color: var(--fg); box-shadow: 0 0 0 1px var(--border); }
  .panel { flex: 1; min-height: 0; display: flex; flex-direction: column; }
</style>
