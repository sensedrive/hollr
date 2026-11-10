<script lang="ts">
  // Plugins of every server (iOS PluginsView, `plugins` gate); a click opens the plugin's web UI (PluginView).
  import { t } from "$lib/i18n";
  import { app, go } from "$lib/store.svelte";
  import { errText } from "$lib/serverapi";
  import { listPlugins, type PluginInfo } from "$lib/plugins";

  type Load = { plugins: PluginInfo[] } | { error: string };
  let loads = $state<Record<string, Load>>({});

  async function load(server: string) {
    try {
      loads[server] = { plugins: await listPlugins(server) };
    } catch (e) {
      const text = errText(e);
      loads[server] = {
        error: text === "not_allowed" ? t("Hollr auf diesem Server ist zu alt für Plugins – in Werkzeuge aktualisieren.") : text,
      };
    }
  }

  $effect(() => {
    for (const s of app.servers) load(s.id);
  });
</script>

<div class="page">
  <div class="page-head">
    <h1>{t("Plugins")}</h1>
    <button class="btn" onclick={() => app.servers.forEach((s) => load(s.id))}>{t("Neu laden")}</button>
  </div>

  {#each app.servers as server (server.id)}
    {@const l = loads[server.id]}
    <h2 class="section">{server.label}</h2>
    {#if !l}
      <div class="rows"><div class="row"><div class="skeleton" style="height: 14px; width: 40%"></div></div></div>
    {:else if "error" in l}
      <p class="foot warn">{l.error}</p>
    {:else if !l.plugins.length}
      <p class="foot">{t("Keine Plugins. Auf dem Server: hollr plugin link <ordner>")}</p>
    {:else}
      <div class="rows">
        {#each l.plugins as p (p.id)}
          <button class="row" disabled={!!p.error} onclick={() => go({ view: "plugin", server: server.id, id: p.id })}>
            <span class="name">{p.name}</span>
            {#if p.error}<span class="small bad">{p.error}</span>
            {:else if p.description}<span class="small muted">{p.description}</span>{/if}
          </button>
        {/each}
      </div>
    {/if}
  {/each}
</div>

<style>
  .section { margin: 18px 2px 6px; color: var(--muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
  .row { all: unset; box-sizing: border-box; width: 100%; cursor: pointer; display: grid; gap: 2px; padding: 10px 14px; }
  .row:hover:not(:disabled) { background: color-mix(in srgb, var(--fg) 5%, transparent); }
  .row:disabled { cursor: default; }
  .row:disabled .name { color: var(--dim); }
  .name { font-weight: 550; }
  .foot { font-size: 12px; color: var(--dim); margin: 4px 2px 0; }
  .warn { color: var(--orange); }
  .bad { color: var(--red); }
  .muted { color: var(--muted); }
</style>
