<script lang="ts">
  // Hollr desktop: servers → workspaces → sessions on the left, the selected session on the right.
  import "../app.css";
  import { onMount } from "svelte";
  import * as api from "$lib/api";
  import type { Pane, Server, Workspace } from "$lib/api";
  import { statusLabel, t } from "$lib/i18n";
  import AgentView from "$lib/components/AgentView.svelte";
  import PairDialog from "$lib/components/PairDialog.svelte";
  import NewSessionDialog from "$lib/components/NewSessionDialog.svelte";

  let servers = $state<Server[]>([]);
  let trees = $state<Record<string, Workspace[]>>({});
  let errors = $state<Record<string, string>>({});
  let selected = $state<{ server: string; pane: string } | null>(null);
  let showShells = $state(false);
  let pairing = $state(false);
  let creating = $state(false);

  async function loadServers() {
    servers = await api.servers();
    if (!servers.length) pairing = true;
    await refresh();
  }

  async function refresh() {
    await Promise.all(
      servers.map(async (s) => {
        try {
          trees[s.id] = await api.tree(s.id);
          delete errors[s.id];
        } catch (e) {
          errors[s.id] = String(e);
        }
      }),
    );
  }

  onMount(() => {
    loadServers();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  });

  // herdr numbers unnamed tabs: show the workspace name instead of "1"
  const tabName = (tab: string, workspace: string) => (/^(Tab )?\d+$/.test(tab) ? workspace : tab);
  const visible = (p: Pane) => showShells || !!p.agent || (selected?.pane === p.pane);
  const current = $derived.by(() => {
    if (!selected) return null;
    for (const w of trees[selected.server] ?? [])
      for (const tab of w.tabs)
        for (const p of tab.panes)
          if (p.pane === selected.pane)
            return { pane: p, title: tabName(tab.label, w.label), workspace: w.label };
    return null;
  });

  async function removeServer(s: Server) {
    if (!confirm(`${s.label} – ${t("Entfernen")}?`)) return;
    await api.removeServer(s.id);
    await loadServers();
  }
</script>

<main>
  <aside>
    <div class="top">
      <b>Hollr</b>
      <div class="tools">
        <button class="btn" onclick={() => (creating = true)} disabled={!servers.length}>＋ {t("Neue Sitzung")}</button>
      </div>
    </div>
    <div class="list">
      {#each servers as s}
        <div class="server">
          <span class="dot" class:bad={!!errors[s.id]}></span>{s.label}
          <button class="x" title={t("Entfernen")} onclick={() => removeServer(s)}>×</button>
        </div>
        {#if errors[s.id]}<div class="err small">{errors[s.id]}</div>{/if}
        {#each trees[s.id] ?? [] as w}
          {@const panes = w.tabs.flatMap((tab) => tab.panes.filter(visible).map((p) => ({ p, tab })))}
          {#if panes.length}
            <div class="ws">{w.label}</div>
            {#each panes as { p, tab }}
              <button class="session" class:sel={selected?.pane === p.pane && selected?.server === s.id}
                onclick={() => (selected = { server: s.id, pane: p.pane })}>
                <span class="dot {p.status}"></span>
                <span class="name">{tabName(tab.label, w.label)}</span>
                <span class="kind dim">{p.agent ?? t("Terminal")} · {statusLabel(p.status)}</span>
              </button>
            {/each}
          {/if}
        {/each}
      {/each}
      {#if !servers.length}<div class="dim small">{t("Kein Server gekoppelt")}</div>{/if}
    </div>
    <div class="bottom">
      <label class="small"><input type="checkbox" bind:checked={showShells} /> {t("Shells anzeigen")}</label>
      <button class="btn" onclick={() => (pairing = true)}>{t("Server koppeln")}</button>
    </div>
  </aside>

  <div class="main">
    {#if selected && current}
      {#key `${selected.server}|${selected.pane}`}
        <AgentView server={selected.server} pane={current.pane} title={current.title}
          onClosed={() => { selected = null; refresh(); }} />
      {/key}
    {:else}
      <div class="empty">{t("Wähle links eine Sitzung.")}</div>
    {/if}
  </div>
</main>

{#if pairing}
  <PairDialog onClose={() => (pairing = false)} onPaired={() => { pairing = false; loadServers(); }} />
{/if}
{#if creating}
  <NewSessionDialog {servers} {trees} onClose={() => (creating = false)}
    onCreated={async (server, pane) => { creating = false; await refresh(); selected = { server, pane }; }} />
{/if}

<style>
  main { display: grid; grid-template-columns: 290px 1fr; height: 100vh; }
  aside { background: var(--side); border-right: 1px solid var(--border); display: flex; flex-direction: column; min-height: 0; }
  .top { display: flex; justify-content: space-between; align-items: center; padding: 14px; font-size: 16px; }
  .list { flex: 1; overflow-y: auto; padding: 0 8px; }
  .bottom { padding: 12px; display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--border); }
  .server { display: flex; align-items: center; gap: 6px; font-weight: 600; padding: 10px 6px 4px; }
  .x { all: unset; cursor: pointer; margin-left: auto; color: var(--dim); }
  .ws { color: var(--muted); font-size: 11px; text-transform: uppercase; padding: 8px 8px 2px; letter-spacing: 0.04em; }
  .session { all: unset; cursor: pointer; display: grid; grid-template-columns: 10px 1fr; column-gap: 8px; padding: 6px 8px;
    border-radius: 8px; width: calc(100% - 16px); }
  .session:hover { background: var(--card); }
  .session.sel { background: color-mix(in srgb, var(--accent) 22%, transparent); }
  .session .dot { grid-row: span 2; align-self: center; }
  .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .kind { font-size: 11px; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--green); }
  .dot.bad { background: var(--orange); }
  .dot.unknown { background: var(--dim); }
  .dot.working { background: var(--purple); }
  .dot.blocked { background: var(--orange); }
  .main { min-width: 0; min-height: 0; }
  .empty { height: 100%; display: grid; place-items: center; color: var(--muted); }
  .small { font-size: 12px; }
  .err { color: var(--red); padding: 0 8px; }
</style>
