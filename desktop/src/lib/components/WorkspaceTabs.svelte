<script lang="ts">
  // herdr's tab bar for the open session's workspace: every tab (and every pane of a split tab) with its
  // number, name and status – one click switches, double-click (or right-click › Umbenennen) renames the
  // tab in herdr, ✕ / middle click closes it (agents after asking), ＋ starts a new session in the same space.
  import { tick } from "svelte";
  import * as api from "$lib/api";
  import { t } from "$lib/i18n";
  import { dialogs, go, mySessions, refresh, type PaneRef } from "$lib/store.svelte";
  import ConfirmDialog from "$lib/views/dashboard/ConfirmDialog.svelte";
  import ContextMenu from "$lib/views/dashboard/ContextMenu.svelte";
  import type { MenuItem } from "$lib/views/dashboard/util";

  let { current }: { current: PaneRef } = $props();

  const ws = $derived(current.workspace);
  const server = $derived(current.server.id);
  type Tab = (typeof ws.tabs)[number];
  type Pane = Tab["panes"][number];

  /** herdr numbers unnamed tabs: show what runs in them instead */
  const unnamed = (tab: Tab) => /^(Tab )?\d+$/.test(tab.label);
  function nameOf(tab: Tab, pane: Pane) {
    if (!unnamed(tab)) return tab.label;
    return pane.agent ?? (pane.title && !/^\d+$/.test(pane.title) ? pane.title : t("Terminal"));
  }

  // ---- rename
  let editing = $state<string | null>(null);
  let draft = $state("");
  let error = $state("");
  let input = $state<HTMLInputElement>();

  async function startRename(tab: Tab) {
    error = "";
    editing = tab.id;
    draft = unnamed(tab) ? "" : tab.label;
    await tick();
    input?.focus();
    input?.select();
  }

  async function commit(tab: Tab) {
    if (editing !== tab.id) return;
    editing = null;
    const label = draft.replace(/\s+/g, " ").trim();
    if (!label || label === tab.label) return;
    // shown right away; the server round trip (SSH) takes a moment – back to the old name if it fails
    const before = tab.label;
    tab.label = label;
    try {
      await api.renameTab(server, tab.id, label);
      refresh(server);
    } catch (e) {
      tab.label = before;
      const msg = e instanceof Error ? e.message : String(e);
      error = msg === "not_allowed" ? t("Hollr auf dem Server ist zu alt – unter Server › Werkzeuge aktualisieren.") : msg;
    }
  }

  function onKey(e: KeyboardEvent, tab: Tab) {
    if (e.key === "Enter") { e.preventDefault(); commit(tab); }
    else if (e.key === "Escape") { e.preventDefault(); editing = null; }
  }

  let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);
  function tabMenu(e: MouseEvent, tab: Tab, pane: Pane) {
    e.preventDefault();
    menu = {
      x: e.clientX, y: e.clientY,
      items: [
        { label: t("Öffnen"), icon: "↗", action: () => go({ view: "agent", server, pane: pane.pane }) },
        { label: t("Umbenennen …"), icon: "✎", action: () => startRename(tab) },
        { label: t("Neue Sitzung hier"), icon: "＋", action: () => (dialogs.newSession = { server, ws: ws.id }) },
        { label: t("Schließen"), icon: "✕", danger: true, action: () => askClose(tab, pane) },
      ],
    };
  }

  // ---- close: a plain terminal right away, an agent session after asking (its work in herdr ends)
  let closing = $state<{ tab: Tab; pane: Pane } | null>(null);
  function askClose(tab: Tab, pane: Pane) {
    if (pane.agent) closing = { tab, pane };
    else void close(pane);
  }
  async function close(pane: Pane) {
    // leaving the closed session: the tab next to it, else the space
    if (pane.pane === current.pane.pane) {
      const all = ws.tabs.flatMap((tb) => tb.panes);
      const i = all.findIndex((p) => p.pane === pane.pane);
      const next = all[i + 1] ?? all[i - 1];
      go(next ? { view: "agent", server, pane: next.pane } : { view: "space", server, ws: ws.id });
    }
    try {
      await api.closePane(server, pane.pane);
      mySessions.remove(`${server}|${pane.pane}`);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    closing = null;
    await refresh(server);
  }
</script>

<div class="tabs" role="tablist" aria-label={ws.label}>
  <button class="ws ellipsis" title={t("Space öffnen")} onclick={() => go({ view: "space", server, ws: ws.id })}>{ws.label}</button>
  <div class="strip">
    {#each ws.tabs as tab (tab.id)}
      {#each tab.panes as pane, i (pane.pane)}
        {@const on = pane.pane === current.pane.pane}
        {#if editing === tab.id && i === 0}
          <div class="tab on edit">
            <span class="num">{tab.number}</span>
            <input bind:this={input} bind:value={draft} placeholder={nameOf(tab, pane)} maxlength="80"
              aria-label={t("Tab umbenennen")} onkeydown={(e) => onKey(e, tab)} onblur={() => commit(tab)} />
          </div>
        {:else}
          <div class="tabwrap" class:on>
            <button class="tab" class:on class:split={i > 0} role="tab" aria-selected={on}
              title="{pane.title || nameOf(tab, pane)} · {t('Doppelklick: umbenennen · Mittelklick: schließen')}"
              onclick={() => go({ view: "agent", server, pane: pane.pane })}
              onauxclick={(e) => { if (e.button === 1) { e.preventDefault(); askClose(tab, pane); } }}
              ondblclick={() => startRename(tab)} oncontextmenu={(e) => tabMenu(e, tab, pane)}>
              <span class="num">{i === 0 ? tab.number : "┊"}</span>
              <span class="dot {pane.status}"></span>
              <span class="name ellipsis">{nameOf(tab, pane)}</span>
            </button>
            <button class="x" title={t("Schließen")} aria-label={t("Schließen")} onclick={() => askClose(tab, pane)}>✕</button>
          </div>
        {/if}
      {/each}
    {/each}
  </div>
  <button class="add" title={t("Neue Sitzung hier")} aria-label={t("Neue Sitzung hier")}
    onclick={() => (dialogs.newSession = { server, ws: ws.id })}>＋</button>
  {#if error}<span class="err ellipsis" title={error}>⚠ {error}</span>{/if}
</div>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => (menu = null)} />
{/if}
{#if closing}
  {@const c = closing}
  <ConfirmDialog title={t("„{name}“ schließen?", { name: nameOf(c.tab, c.pane) })}
    message={t("Die Session wird in herdr beendet – {agent} hört dabei auf zu arbeiten.", { agent: c.pane.agent ?? "" })}
    confirmLabel={t("Schließen")} onConfirm={() => close(c.pane)} onClose={() => (closing = null)} />
{/if}

<style>
  .tabs { display: flex; align-items: stretch; gap: 2px; padding: 5px 10px 0; border-bottom: 1px solid var(--border);
    background: var(--side); font-family: var(--mono); font-size: 12px; min-width: 0; }
  .ws { all: unset; cursor: pointer; align-self: center; max-width: 160px; padding: 0 10px 5px 6px; color: var(--muted); font-weight: 600; }
  .ws:hover { color: var(--fg); }
  .strip { display: flex; gap: 2px; overflow-x: auto; min-width: 0; scrollbar-width: none; }
  .strip::-webkit-scrollbar { display: none; }
  .tabwrap { position: relative; display: flex; flex: none; }
  .tab { all: unset; cursor: pointer; display: flex; align-items: center; gap: 6px; padding: 5px 26px 6px 12px; max-width: 220px;
    border: 1px solid transparent; border-bottom: none; border-radius: 8px 8px 0 0; color: var(--muted); flex: none; }
  .tab:hover { color: var(--fg); background: color-mix(in srgb, var(--fg) 5%, transparent); }
  .tab.on { color: var(--fg); background: var(--bg); border-color: var(--border); margin-bottom: -1px; }
  .tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .tab.split { padding-left: 8px; }
  .x { all: unset; cursor: pointer; position: absolute; right: 6px; top: 50%; translate: 0 -45%; width: 16px; height: 16px;
    display: grid; place-items: center; border-radius: 4px; font-size: 9px; color: var(--muted); opacity: 0; }
  .tabwrap:hover .x, .tabwrap.on .x, .x:focus-visible { opacity: 1; }
  .x:hover { background: var(--border); color: var(--fg); }
  .tab.edit { cursor: text; padding-top: 3px; padding-bottom: 4px; }
  .tab.edit input { all: unset; width: 160px; padding: 2px 6px; border-radius: 5px; color: var(--fg); font: inherit;
    background: var(--card); box-shadow: 0 0 0 1px var(--accent); }
  .num { color: var(--dim); }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; box-sizing: border-box; border: 1.5px solid var(--green); }
  .dot.working { background: var(--purple); border-color: var(--purple); }
  .dot.blocked { background: var(--orange); border-color: var(--orange); }
  .dot.done { background: var(--green); }
  .dot.unknown { width: 4px; height: 4px; border: none; background: var(--dim); }
  .add { all: unset; cursor: pointer; align-self: center; padding: 0 8px 5px; color: var(--muted); font-size: 14px; }
  .add:hover { color: var(--fg); }
  .err { align-self: center; max-width: 40%; padding: 0 6px 5px; color: var(--orange); font-family: var(--font, inherit); font-size: 11.5px; }
  .ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
