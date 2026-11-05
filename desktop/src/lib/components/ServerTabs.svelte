<script lang="ts">
  // The server switcher at the top of the sidebar (the spaces below it belong to the chosen server): one chip per
  // paired server with its connection, how many sessions need you there and a running live call. A click returns to
  // the session last opened on that server (else the one that needs you most, else Server-Info); ⌘⌥1…9 does the
  // same, right-click has Server-Info, Werkzeuge and a new session there, ＋ pairs another server. Chips can be
  // dragged into another order (kept per computer; ⌘⌥ follows it).
  import { untrack } from "svelte";
  import { t } from "$lib/i18n";
  import { allPanes, app, dialogs, go, nav } from "$lib/store.svelte";
  import { inboxEntries } from "$lib/inbox.svelte";
  import { lastSessionOf, rememberSession, serverTarget } from "$lib/serverTabs";
  import ContextMenu from "$lib/views/dashboard/ContextMenu.svelte";
  import type { MenuItem } from "$lib/views/dashboard/util";
  import LiveMark from "./LiveMark.svelte";
  import Icon from "./git/Icon.svelte";
  import { currentServer } from "$lib/currentServer.svelte";
  import { sortable } from "$lib/sortable";
  import { moveBefore, ordered } from "$lib/tabOrder";
  import { tabOrders } from "$lib/tabOrders.svelte";

  const servers = $derived(ordered(app.servers, tabOrders.all.servers, (s) => s.id));
  const moveServer = (id: string, before: string | null) =>
    tabOrders.set("servers", moveBefore(servers.map((s) => s.id), id, before));

  // the session in front of the user is the one to come back to on its server
  $effect(() => {
    const r = nav.route;
    if (r.view === "agent") untrack(() => rememberSession(r.server, r.pane));
  });

  // also on the overview / settings: the remote whose spaces the sidebar shows
  const active = $derived(currentServer());

  const counts = $derived.by(() => {
    const c: Record<string, number> = {};
    for (const e of inboxEntries()) c[e.ref.server.id] = (c[e.ref.server.id] ?? 0) + 1;
    return c;
  });

  function open(id: string) {
    const panes = allPanes(id).map((r) => ({ pane: r.pane.pane, status: r.pane.status }));
    const pane = serverTarget(lastSessionOf(id), panes, !!app.loaded[id]);
    go(pane ? { view: "agent", server: id, pane } : { view: "serverinfo", server: id });
  }

  function onKey(e: KeyboardEvent) {
    if (!(e.metaKey || e.ctrlKey) || !e.altKey || e.shiftKey) return;
    const n = /^Digit([1-9])$/.exec(e.code)?.[1];
    const s = n ? servers[Number(n) - 1] : undefined;
    if (!s) return;
    e.preventDefault();
    open(s.id);
  }

  let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);
  function tabMenu(e: MouseEvent, id: string) {
    e.preventDefault();
    menu = {
      x: e.clientX, y: e.clientY,
      items: [
        { label: t("Server-Info"), icon: "ⓘ", action: () => go({ view: "serverinfo", server: id }) },
        { label: t("Werkzeuge"), icon: "⚒", action: () => go({ view: "tools", server: id }) },
        { label: t("Neue Sitzung hier"), icon: "＋", action: () => (dialogs.newSession = { server: id }) },
      ],
    };
  }

  const mod = navigator.platform.toLowerCase().includes("mac") ? "⌘⌥" : "Ctrl+Alt+";
</script>

<svelte:window onkeydown={onKey} />

{#if app.servers.length}
  <div class="tabs" role="tablist" aria-label={t("Server")}>
    <div class="strip" use:sortable={{ onMove: moveServer }}>
      {#each servers as s, i (s.id)}
        {@const on = s.id === active}
        {@const err = app.errors[s.id]}
        {@const n = counts[s.id] ?? 0}
        <button class="tab" class:on role="tab" aria-selected={on} data-sort-id={s.id}
          title="{s.label}{err ? ` · ⚠ ${err}` : ''}{i < 9 ? ` · ${mod}${i + 1}` : ''}"
          onclick={() => open(s.id)} oncontextmenu={(e) => tabMenu(e, s.id)}>
          <span class="conn" class:bad={!!err}></span>
          <span class="name ellipsis">{s.label}</span>
          <LiveMark server={s.id} />
          {#if n}<span class="count" title={t("Braucht dich")}>{n}</span>{/if}
        </button>
      {/each}
    </div>
    <button class="add" title={t("Server koppeln")} aria-label={t("Server koppeln")} onclick={() => (dialogs.pair = true)}><Icon name="plus" size={14} /></button>
  </div>
{/if}

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => (menu = null)} />
{/if}

<style>
  /* at the top of the sidebar: small chips that wrap, the chosen one raised */
  .tabs { display: flex; align-items: center; gap: 2px; padding: 12px 8px 8px; font-size: 12.5px; min-width: 0; }
  .strip { position: relative; display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
  .tab { all: unset; cursor: pointer; display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; max-width: 100%;
    border: 1px solid transparent; border-radius: 8px; color: var(--muted); flex: none; }
  .tab:hover { color: var(--fg); background: color-mix(in srgb, var(--fg) 5%, transparent); }
  .tab.on { color: var(--fg); background: var(--card); border-color: var(--border); font-weight: 600; }
  .tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .conn { width: 6px; height: 6px; border-radius: 50%; background: var(--green); flex: none; }
  .conn.bad { background: var(--red); }
  .count { min-width: 16px; height: 16px; padding: 0 4px; box-sizing: border-box; border-radius: 8px; display: grid; place-items: center;
    font-size: 10.5px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--bg); background: var(--orange); }
  .add { all: unset; cursor: pointer; align-self: center; width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px; color: var(--dim); }
  .add:hover { color: var(--fg); background: color-mix(in srgb, var(--fg) 6%, transparent); }
  .add:focus-visible { outline: 2px solid var(--accent); }
  .ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
