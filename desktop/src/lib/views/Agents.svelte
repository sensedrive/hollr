<script lang="ts">
  // All agents of all servers (like Heeler's Agents tab): by status or by workspace, shells optional.
  import * as api from "$lib/api";
  import { t } from "$lib/i18n";
  import { settings } from "$lib/settings.svelte";
  import { allPanes, app, dialogs, refresh, type PaneRef } from "$lib/store.svelte";
  import AgentRow from "./dashboard/AgentRow.svelte";
  import ConfirmDialog from "./dashboard/ConfirmDialog.svelte";
  import ContextMenu from "./dashboard/ContextMenu.svelte";
  import { agentName, arrowNav, refTitle, sortRefs, type MenuItem } from "./dashboard/util";
  import { go, mySessions } from "$lib/store.svelte";

  type Grouping = "status" | "workspace";
  const GKEY = "hollr.grouping";
  let grouping = $state<Grouping>((() => {
    try { return localStorage.getItem(GKEY) === "workspace" ? "workspace" : "status"; } catch { return "status"; }
  })());
  $effect(() => { try { localStorage.setItem(GKEY, grouping); } catch {} });

  let query = $state("");
  let searchEl = $state<HTMLInputElement>();

  const matches = (r: PaneRef) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [refTitle(r), r.workspace.label, r.server.label, r.pane.title, r.pane.cwd, agentName(r.pane)]
      .join(" ").toLowerCase().includes(q);
  };
  const visible = $derived(allPanes().filter((r) => (settings.showShells || !!r.pane.agent) && matches(r)));
  const byStatus = $derived(sortRefs(visible));
  const byWorkspace = $derived(
    app.servers.flatMap((s) =>
      (app.trees[s.id] ?? []).map((ws) => ({
        key: `${s.id}|${ws.id}`,
        title: app.servers.length > 1 ? `${s.label} · ${ws.label}` : ws.label,
        server: s.id, ws: ws.id,
        refs: visible.filter((r) => r.server.id === s.id && r.workspace.id === ws.id),
      })).filter((g) => g.refs.length),
    ),
  );
  const loaded = $derived(app.servers.every((s) => app.loaded[s.id]));
  const multi = $derived(app.servers.length > 1);
  const total = $derived(allPanes().filter((r) => settings.showShells || !!r.pane.agent).length);

  let closing = $state<PaneRef | null>(null);
  let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);

  function rowMenu(e: MouseEvent, r: PaneRef) {
    menu = {
      x: e.clientX, y: e.clientY,
      items: [
        { label: t("Öffnen"), icon: "↗", action: () => go({ view: "agent", server: r.server.id, pane: r.pane.pane }) },
        ...(mySessions.ids.includes(r.id)
          ? [{ label: t("Aus der Übersicht nehmen"), icon: "◌", action: () => mySessions.remove(r.id) }]
          : [{ label: t("Zur Übersicht hinzufügen"), icon: "▦", action: () => mySessions.touch(r.id) }]),
        { label: t("Space öffnen"), icon: "❒", action: () => go({ view: "space", server: r.server.id, ws: r.workspace.id }) },
        { label: t("Schließen"), icon: "✕", danger: true, action: () => (closing = r) },
      ],
    };
  }

  async function close(r: PaneRef) {
    await api.closePane(r.server.id, r.pane.pane);
    mySessions.remove(r.id);
    closing = null;
    await refresh();
  }

  function onKey(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "f") { e.preventDefault(); searchEl?.focus(); }
    else if (e.key === "/" && !(e.target as HTMLElement).matches("input, textarea, select")) { e.preventDefault(); searchEl?.focus(); }
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="page">
  <div class="page-head">
    <h1>{t("Agents")}</h1>
    <input class="search" placeholder={t("Filtern …")} bind:value={query} bind:this={searchEl}
      onkeydown={(e) => { if (e.key === "Escape") { query = ""; searchEl?.blur(); } }} />
    <div class="seg" role="radiogroup" aria-label={t("Sortierung")}>
      <button role="radio" aria-checked={grouping === "status"} class:on={grouping === "status"} onclick={() => (grouping = "status")}>{t("Nach Status")}</button>
      <button role="radio" aria-checked={grouping === "workspace"} class:on={grouping === "workspace"} onclick={() => (grouping = "workspace")}>{t("Nach Workspace")}</button>
    </div>
    <label class="shells small"><input type="checkbox" class="toggle" bind:checked={settings.showShells} />{t("Shells anzeigen")}</label>
    <button class="btn primary" disabled={!app.servers.length} onclick={() => (dialogs.newSession = {})}>＋ {t("Neue Sitzung")}</button>
  </div>

  {#each app.servers as s (s.id)}
    {#if app.errors[s.id]}<div class="warn small">⚠ {s.label}: {app.errors[s.id]}</div>{/if}
  {/each}

  {#if !loaded && !visible.length}
    <div class="rows">
      {#each Array(8) as _, i}
        <div class="row"><div class="skeleton" style="width:38px;height:38px;border-radius:10px"></div>
          <div class="grow" style="display:grid; gap:6px">
            <div class="skeleton" style="height:10px; width:{[30, 22, 36, 26, 18, 32, 24, 28][i]}%"></div>
            <div class="skeleton" style="height:13px; width:{[52, 40, 60, 46, 38, 56, 44, 50][i]}%"></div>
          </div></div>
      {/each}
    </div>
  {:else if !visible.length}
    <div class="empty">
      <div class="big">▥</div>
      <b>{query ? t("Keine Treffer") : t("Keine Agents")}</b>
      {#if !query && !total}<div class="muted">{t("Starte in herdr eine omp-Session.")}</div>
        <button class="btn primary" disabled={!app.servers.length} onclick={() => (dialogs.newSession = {})}>＋ {t("Neue Sitzung")}</button>{/if}
    </div>
  {:else if grouping === "status"}
    <div class="rows" use:arrowNav>
      {#each byStatus as r (r.id)}
        <AgentRow ref={r} showServer={multi} onClose={() => (closing = r)} onMenu={(e) => rowMenu(e, r)} />
      {/each}
    </div>
  {:else}
    <div use:arrowNav>
      {#each byWorkspace as g (g.key)}
        <div class="section ghead">
          <button class="link" onclick={() => go({ view: "space", server: g.server, ws: g.ws })}>{g.title}</button>
          <span class="grow"></span>
          <button class="link plus" title={t("Neue Sitzung")} onclick={() => (dialogs.newSession = { server: g.server, ws: g.ws })}>＋</button>
        </div>
        <div class="rows">
          {#each g.refs as r (r.id)}
            <AgentRow ref={r} onClose={() => (closing = r)} onMenu={(e) => rowMenu(e, r)} />
          {/each}
        </div>
      {/each}
    </div>
  {/if}
</div>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => (menu = null)} />
{/if}
{#if closing}
  {@const r = closing}
  <ConfirmDialog title={t("Chat schließen?")} confirmLabel={t("Schließen")}
    message={t("„{title}“ wird in herdr geschlossen und {agent} beendet.", { title: refTitle(r), agent: agentName(r.pane) })}
    onConfirm={() => close(r)} onClose={() => (closing = null)} />
{/if}

<style>
  .page-head { flex-wrap: wrap; }
  .search { width: 200px; padding: 5px 10px; }
  .seg { display: inline-flex; background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 2px; }
  .seg button { all: unset; cursor: pointer; padding: 3px 10px; border-radius: 6px; font-size: 12px; color: var(--muted); }
  .seg button.on { background: var(--raised); color: var(--fg); box-shadow: 0 0 0 1px var(--border); }
  .seg button:focus-visible { outline: 2px solid var(--accent); }
  .shells { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); cursor: pointer; }
  .warn { color: var(--orange); margin-bottom: 8px; }
  .ghead { display: flex; align-items: center; }
  .link { all: unset; cursor: pointer; }
  .link:hover, .link:focus-visible { color: var(--fg); }
  .plus { font-size: 14px; padding: 0 4px; }
  .empty { display: grid; justify-items: center; gap: 8px; padding: 60px 0; text-align: center; }
  .empty .big { font-size: 34px; color: var(--dim); }
</style>
