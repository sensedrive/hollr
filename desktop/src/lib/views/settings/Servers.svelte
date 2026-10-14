<script lang="ts">
  // Settings → Server & Geräte (iOS ServersView + the per-server links of SettingsView).
  import * as api from "$lib/api";
  import type { Server } from "$lib/api";
  import { t } from "$lib/i18n";
  import { allPanes, app, dialogs, go, loadServers } from "$lib/store.svelte";
  import { errText } from "$lib/serverapi";
  import SetupCommands from "./SetupCommands.svelte";

  let confirm = $state<Server | null>(null);
  let error = $state("");
  let busy = $state(false);

  const agents = (id: string) => allPanes(id).filter((r) => r.pane.agent).length;
  const address = (s: Server) => `${s.user}@${s.addresses[0] ?? "?"}${s.port !== 22 ? `:${s.port}` : ""}`;

  async function remove(s: Server) {
    busy = true;
    try {
      await api.removeServer(s.id);
      confirm = null;
      error = "";
      await loadServers();
    } catch (e) {
      error = errText(e);
    }
    busy = false;
  }
</script>

<div class="page">
  <div class="page-head">
    <h1>{t("Server & Geräte")}</h1>
    <button class="btn primary" onclick={() => (dialogs.pair = true)}>＋ {t("Server koppeln")}</button>
  </div>

  {#if error}<div class="card err">{error}</div>{/if}

  {#if app.servers.length}
    <div class="rows">
      {#each app.servers as s (s.id)}
        <div class="srv">
          <div class="icon">▤</div>
          <div class="grow">
            <div class="name">{s.label}</div>
            <div class="small muted mono ellipsis" title={s.addresses.join(", ")}>{address(s)}</div>
            {#if s.network === "lan" || s.network === "tailscale"}
              <div class="small dim">{s.network === "tailscale" ? t("Tailscale / Fernzugriff") : t("Lokales Netzwerk")}</div>
            {/if}
            {#if app.errors[s.id]}
              <div class="small warn">{app.errors[s.id]}</div>
            {:else if app.loaded[s.id]}
              <div class="small dim">{t("{n} Agents · Gerät {device}", { n: agents(s.id), device: s.deviceId })}</div>
            {:else}
              <div class="skeleton" style="height: 12px; width: 140px; margin-top: 3px"></div>
            {/if}
          </div>
          <div class="actions">
            <button class="btn" onclick={() => go({ view: "serverinfo", server: s.id })}>{t("Server-Info")}</button>
            <button class="btn" onclick={() => go({ view: "tools", server: s.id })}>{t("Werkzeuge")}</button>
            <button class="btn danger" onclick={() => (confirm = s)}>{t("Entfernen")}</button>
          </div>
          {#if confirm?.id === s.id}
            <div class="confirm">
              <div class="grow">
                <b>{t("Server aus Hollr entfernen?")}</b>
                <div class="small muted">{t("Auf dem Server bleibt der Schlüssel bis `hollr revoke {device}`.", { device: s.deviceId })}</div>
              </div>
              <button class="btn" onclick={() => (confirm = null)}>{t("Abbrechen")}</button>
              <button class="btn danger" disabled={busy} onclick={() => remove(s)}>{t("Entfernen")}</button>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {:else}
    <div class="card muted">{t("Kein Server gekoppelt")}</div>
  {/if}
  <p class="foot">{t("Team: Jede Person koppelt ihr eigenes Gerät mit `hollr pair`. Entfernen auf dem Server mit `hollr revoke <name>`.")}</p>

  <div class="section">{t("Server einrichten")}</div>
  <div class="card"><SetupCommands /></div>
</div>

<style>
  .srv { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px 14px; }
  .icon { width: 36px; height: 36px; border-radius: 9px; display: grid; place-items: center; color: var(--accent);
    background: color-mix(in srgb, var(--accent) 15%, transparent); flex: none; }
  .name { font-weight: 600; }
  .warn { color: var(--orange); }
  .actions { display: flex; gap: 6px; }
  .confirm { flex-basis: 100%; display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-radius: 10px;
    background: color-mix(in srgb, var(--red) 10%, transparent); }
  .foot { color: var(--dim); font-size: 12px; margin: 6px 4px 0; }
</style>
