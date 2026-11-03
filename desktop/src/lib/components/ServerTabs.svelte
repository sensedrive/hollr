<script lang="ts">
  // The remotes like a terminal multiplexer's session bar, above every view: one tab per paired server with its
  // connection, how many sessions need you there and a running live call. A click returns to the session last
  // opened on that server (else the one that needs you most, else Server-Info); ⌘⌥1…9 does the same,
  // right-click has Server-Info, Werkzeuge and a new session there, ＋ pairs another server. Tabs can be
  // dragged into another order (kept per computer; numbers and ⌘⌥ follow it).
  import { untrack } from "svelte";
  import { t } from "$lib/i18n";
  import { allPanes, app, dialogs, go, nav } from "$lib/store.svelte";
  import { inboxEntries } from "$lib/inbox.svelte";
  import { lastSessionOf, rememberSession, serverTarget } from "$lib/serverTabs";
  import ContextMenu from "$lib/views/dashboard/ContextMenu.svelte";
  import type { MenuItem } from "$lib/views/dashboard/util";
  import LiveMark from "./LiveMark.svelte";
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
  <div class="tabs" class:above={nav.route.view === "agent" || nav.route.view === "space"} role="tablist" aria-label={t("Server")}>
    <div class="strip" use:sortable={{ onMove: moveServer }}>
      {#each servers as s, i (s.id)}
        {@const on = s.id === active}
        {@const err = app.errors[s.id]}
        {@const n = counts[s.id] ?? 0}
        <button class="tab" class:on role="tab" aria-selected={on} data-sort-id={s.id}
          title="{s.label}{err ? ` · ⚠ ${err}` : ''}{i < 9 ? ` · ${mod}${i + 1}` : ''}"
          onclick={() => open(s.id)} oncontextmenu={(e) => tabMenu(e, s.id)}>
          {#if i < 9}<span class="num">{i + 1}</span>{/if}
          <span class="conn" class:bad={!!err}></span>
          <span class="name ellipsis">{s.label}</span>
          <LiveMark server={s.id} />
          {#if n}<span class="count" title={t("Braucht dich")}>{n}</span>{/if}
        </button>
      {/each}
    </div>
    <button class="add" title={t("Server koppeln")} aria-label={t("Server koppeln")} onclick={() => (dialogs.pair = true)}>＋</button>
  </div>
{/if}

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => (menu = null)} />
{/if}

<style>
  .tabs { display: flex; align-items: stretch; gap: 2px; padding: 5px 10px 0; border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--side) 70%, var(--bg)); font-family: var(--mono); font-size: 12px; min-width: 0; }
  .strip { position: relative; display: flex; gap: 2px; overflow-x: auto; min-width: 0; scrollbar-width: none; }
  .strip::-webkit-scrollbar { display: none; }
  .tab { all: unset; cursor: pointer; display: flex; align-items: center; gap: 6px; padding: 4px 12px 5px; max-width: 240px;
    border: 1px solid transparent; border-bottom: none; border-radius: 8px 8px 0 0; color: var(--muted); flex: none; }
  .tab:hover { color: var(--fg); background: color-mix(in srgb, var(--fg) 5%, transparent); }
  /* the active tab opens into what is below: the session's tab bar, else the view itself */
  .tab.on { color: var(--fg); background: var(--bg); border-color: var(--border); margin-bottom: -1px; font-weight: 600; }
  .above .tab.on { background: var(--side); }
  .tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .num { color: var(--dim); font-weight: 400; }
  .conn { width: 6px; height: 6px; border-radius: 50%; background: var(--green); flex: none; }
  .conn.bad { background: var(--red); }
  .count { min-width: 16px; height: 16px; padding: 0 4px; box-sizing: border-box; border-radius: 8px; display: grid; place-items: center;
    font-size: 10.5px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--bg); background: var(--orange); }
  .add { all: unset; cursor: pointer; align-self: center; padding: 0 8px 4px; color: var(--muted); font-size: 14px; }
  .add:hover { color: var(--fg); }
  .ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
