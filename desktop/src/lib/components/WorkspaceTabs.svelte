<script lang="ts">
  // herdr's tab bar for a workspace, above its sessions and its space view: the space itself as the first tab
  // (its overview), then every tab (and every pane of a split tab) with its status dot and name – one click
  // switches, double-click (or right-click › Umbenennen) renames the tab in herdr, ✕ / middle click closes it
  // (agents after asking), ＋ starts a new session in the same space. 〰 marks the tab a live call runs on, ↳ a chat
  // with context (a fork of another session, `fork` on the server) – it sits right behind its session's tab. In a
  // session the bar also carries its tools (`actions`).
  // Tabs can be dragged into another order – kept in Hollr per workspace (herdr has no "tab move").
  import { tick, type Snippet } from "svelte";
  import Icon from "./git/Icon.svelte";
  import { isSideChatLabel } from "$lib/sidechats.svelte";
  import * as api from "$lib/api";
  import { t } from "$lib/i18n";
  import type { Workspace } from "$lib/api";
  import { dialogs, go, mySessions, refresh } from "$lib/store.svelte";
  import ConfirmDialog from "$lib/views/dashboard/ConfirmDialog.svelte";
  import ContextMenu from "$lib/views/dashboard/ContextMenu.svelte";
  import type { MenuItem } from "$lib/views/dashboard/util";
  import LiveMark from "./LiveMark.svelte";
  import { sortable } from "$lib/sortable";
  import { forksAfterParents, moveBefore, ordered } from "$lib/tabOrder";
  import { chatLabel } from "$lib/contextChatText";
  import { canFork, contextChat, startContextChat } from "$lib/contextChat.svelte";
  import { tabOrders } from "$lib/tabOrders.svelte";

  /** `active`: the open session's pane – none in the space view, then the space tab is the active one */
  /** `actions`: the open session's tools, right-aligned in the same bar (AgentView) */
  let { server, workspace: ws, active, actions }: { server: string; workspace: Workspace; active?: string; actions?: Snippet } = $props();
  type Tab = (typeof ws.tabs)[number];
  type Pane = Tab["panes"][number];

  const orderKey = $derived(`${server}|${ws.id}`);
  // a chat with context sits right behind its session's tab; sidechats ("Nachfragen") are forks too – they live
  // in the session's panel, not here
  const tabs = $derived.by(() => {
    const own = ws.tabs.filter((tb) => !isSideChatLabel(tb.label));
    const tabOf = new Map(own.flatMap((tb) => tb.panes.map((p) => [p.pane, tb.id] as const)));
    return forksAfterParents(ordered(own, tabOrders.all[orderKey], (tb) => tb.id), (tb) => tb.id, (tb) => {
      const of = tb.panes[0]?.fork?.of;
      return of ? tabOf.get(of) : undefined;
    });
  });
  const moveTab = (id: string, before: string | null) =>
    tabOrders.set(orderKey, moveBefore(tabs.map((tb) => tb.id), id, before));

  // the open session's tab stays in sight: with its tools in the same bar the strip is narrow, and the tab is the
  // only place that names the session (no header)
  let strip = $state<HTMLElement>();
  $effect(() => {
    if (!strip || !active) return;
    const el = strip.querySelector<HTMLElement>(".tabwrap.on");
    if (!el) return;
    const s = strip.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    // a tab wider than the strip shows its start (dot and name)
    if (r.right > s.right) strip.scrollLeft += Math.min(r.right - s.right, r.left - s.left);
    else if (r.left < s.left) strip.scrollLeft += r.left - s.left;
  });

  /** herdr numbers unnamed tabs: show what runs in them instead */
  const unnamed = (tab: Tab) => /^(Tab )?\d+$/.test(tab.label);
  function nameOf(tab: Tab, pane: Pane) {
    if (!unnamed(tab)) return chatLabel(tab.label);
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

  const openTab = (pane: Pane) => go({ view: "agent", server, pane: pane.pane });

  /** the session a chat with context continues (its tab's name) */
  function sourceName(pane: Pane) {
    const of = pane.fork?.of;
    const tab = of ? ws.tabs.find((tb) => tb.panes.some((p) => p.pane === of)) : undefined;
    const src = tab?.panes.find((p) => p.pane === of);
    return tab && src ? nameOf(tab, src) : "";
  }

  let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);
  function tabMenu(e: MouseEvent, tab: Tab, pane: Pane) {
    e.preventDefault();
    menu = {
      x: e.clientX, y: e.clientY,
      items: [
        { label: t("Öffnen"), icon: "↗", action: () => openTab(pane) },
        { label: t("Umbenennen …"), icon: "✎", action: () => startRename(tab) },
        { label: t("Neue Sitzung hier"), icon: "＋", action: () => (dialogs.newSession = { server, ws: ws.id }) },
        ...(canFork(pane) && !contextChat.busy
          ? [{ label: t("Neuer Chat mit Kontext"), icon: "chat-plus", action: () => void startContextChat(server, pane.pane) }]
          : []),
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
    if (pane.pane === active) {
      const all = tabs.flatMap((tb) => tb.panes);
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
  <button class="tab home" class:on={!active} role="tab" aria-selected={!active} title={t("Space öffnen")}
    onclick={() => go({ view: "space", server, ws: ws.id })}><span class="num"><Icon name="space" size={14} /></span><span class="name ellipsis">{ws.label}</span></button>
  <div class="strip" bind:this={strip} use:sortable={{ onMove: moveTab }}>
    {#each tabs as tab (tab.id)}
      {#each tab.panes as pane, i (pane.pane)}
        {@const on = pane.pane === active}
        {#if editing === tab.id && i === 0}
          <div class="tab on edit">
            <span class="num">{tab.number}</span>
            <input bind:this={input} bind:value={draft} placeholder={nameOf(tab, pane)} maxlength="80"
              aria-label={t("Tab umbenennen")} onkeydown={(e) => onKey(e, tab)} onblur={() => commit(tab)} />
          </div>
        {:else}
          <div class="tabwrap" class:on data-sort-id={tab.id}>
            <button class="tab" class:on class:split={i > 0} role="tab" aria-selected={on}
              title="{pane.fork ? `${t('Chat mit dem Verlauf von „{name}“', { name: sourceName(pane) || pane.title })} · ` : ''}{pane.title || nameOf(tab, pane)} · {t('Doppelklick: umbenennen · Mittelklick: schließen')}"
              onclick={() => openTab(pane)}
              onauxclick={(e) => { if (e.button === 1) { e.preventDefault(); askClose(tab, pane); } }}
              ondblclick={() => startRename(tab)} oncontextmenu={(e) => tabMenu(e, tab, pane)}>
              <span class="dot {pane.status}"></span>
              {#if pane.fork}<span class="derived"><Icon name="corner" size={12} /></span>{/if}
              <span class="name ellipsis">{nameOf(tab, pane)}</span>
              <LiveMark {server} pane={pane.pane} />
            </button>
            <button class="x" title={t("Schließen")} aria-label={t("Schließen")} onclick={() => askClose(tab, pane)}><Icon name="x" size={11} /></button>
          </div>
        {/if}
      {/each}
    {/each}
  </div>
  <button class="add" title={t("Neue Sitzung hier")} aria-label={t("Neue Sitzung hier")}
    onclick={() => (dialogs.newSession = { server, ws: ws.id })}><Icon name="plus" size={15} /></button>
  {#if error}<span class="err ellipsis" title={error}><Icon name="⚠" size={15} /> {error}</span>{/if}
  {#if actions}<div class="tools">{@render actions()}</div>{/if}
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
    background: var(--side); font-size: 13px; min-width: 0; }
  .tools { margin-left: auto; padding: 0 0 5px 12px; display: flex; align-items: center; flex: none; }
  .num { display: grid; place-items: center; }
  .tab.home { padding-right: 12px; max-width: 180px; font-weight: 600; }
  .strip { position: relative; display: flex; gap: 2px; overflow-x: auto; min-width: 0; scrollbar-width: none; }
  .strip::-webkit-scrollbar { display: none; }
  .tabwrap { position: relative; display: flex; flex: none; }
  .tab { all: unset; cursor: pointer; display: flex; align-items: center; gap: 6px; padding: 5px 26px 6px 12px; max-width: 220px;
    border: 1px solid transparent; border-bottom: none; border-radius: 8px 8px 0 0; color: var(--muted); flex: none; }
  .tab:hover { color: var(--fg); background: color-mix(in srgb, var(--fg) 5%, transparent); }
  .tab.on { color: var(--fg); background: var(--bg); border-color: var(--border); margin-bottom: -1px; }
  .tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .tab.split { padding-left: 8px; }
  /* a chat with context: the session's name, marked as derived */
  .derived { display: grid; place-items: center; color: var(--dim); margin-right: -2px; }
  .x { all: unset; cursor: pointer; position: absolute; right: 6px; top: 50%; translate: 0 -45%; width: 16px; height: 16px;
    display: grid; place-items: center; border-radius: 4px; font-size: 9px; color: var(--muted); opacity: 0; }
  .tabwrap:hover .x, .tabwrap.on .x, .x:focus-visible { opacity: 1; }
  .x:hover { background: var(--border); color: var(--fg); }
  .tab.edit { cursor: text; padding-top: 3px; padding-bottom: 4px; }
  .tab.edit input { all: unset; width: 160px; padding: 2px 6px; border-radius: 5px; color: var(--fg); font: inherit;
    background: var(--card); box-shadow: 0 0 0 1px var(--accent); }
  .num { color: var(--dim); }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; box-sizing: border-box; border: 1.5px solid var(--dim); }
  .dot.working { background: var(--purple); border-color: var(--purple); }
  .dot.blocked { background: var(--orange); border-color: var(--orange); }
  .dot.done { background: var(--accent); border-color: var(--accent); }
  .dot.unknown { width: 4px; height: 4px; border: none; background: var(--dim); }
  .add { all: unset; cursor: pointer; align-self: center; display: grid; place-items: center; width: 26px; height: 26px; margin-bottom: 4px;
    border-radius: 6px; color: var(--dim); }
  .add:focus-visible { outline: 2px solid var(--accent); }
  .add:hover { color: var(--fg); }
  .err { align-self: center; max-width: 40%; padding: 0 6px 5px; color: var(--orange); font-family: var(--font, inherit); font-size: 11.5px; }
  .ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
