<script lang="ts">
  // Hollr desktop shell: sidebar (navigation + my sessions) and the current view on the right.
  import "../app.css";
  import { onMount } from "svelte";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { statusLabel, t } from "$lib/i18n";
  import { settings } from "$lib/settings.svelte";
  import * as theme from "$lib/theme";
  import {
    app, back, dialogs, findPane, go, listenFeeds, loadServers, mySessions, nav, poll, refresh, refreshSpaces, tabName, type Route,
  } from "$lib/store.svelte";
  import AgentView from "$lib/components/AgentView.svelte";
  import PairDialog from "$lib/components/PairDialog.svelte";
  import NewSessionDialog from "$lib/components/NewSessionDialog.svelte";
  import Dashboard from "$lib/views/Dashboard.svelte";
  import Agents from "$lib/views/Agents.svelte";
  import Spaces from "$lib/views/Spaces.svelte";
  import SpaceDetail from "$lib/views/SpaceDetail.svelte";
  import Settings from "$lib/views/Settings.svelte";
  import ServerInfo from "$lib/views/ServerInfo.svelte";
  import Tools from "$lib/views/Tools.svelte";
  import NewSpaceDialog from "$lib/views/NewSpaceDialog.svelte";
  import Notifier from "$lib/views/Notifier.svelte";

  // ---- theme (fixed palette or following the system)
  let systemDark = $state(matchMedia("(prefers-color-scheme: dark)").matches);
  $effect(() => {
    const name = settings.followSystem ? (systemDark ? settings.darkTheme : settings.lightTheme) : settings.theme;
    theme.apply(theme.named(name) ?? theme.DARK[0]!);
  });

  // ---- zoom ("Ansicht skalieren")
  $effect(() => {
    const z = settings.zoom;
    getCurrentWebview().setZoom(z).catch(() => {});
  });
  const zoomBy = (d: number) => (settings.zoom = Math.round(Math.min(1.6, Math.max(0.7, settings.zoom + d)) * 100) / 100);

  function onKey(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key;
    if (k === "=" || k === "+") zoomBy(0.1);
    else if (k === "-") zoomBy(-0.1);
    else if (k === "0") settings.zoom = 1;
    else if (k === "n" && app.servers.length) dialogs.newSession = {};
    else if (k === ",") go({ view: "settings" });
    else if (k === "1") go({ view: "dashboard" });
    else if (k === "2") go({ view: "agents" });
    else if (k === "3") go({ view: "spaces" });
    else if (k === "[") back();
    else return;
    e.preventDefault();
  }

  onMount(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => (systemDark = mq.matches);
    mq.addEventListener("change", onScheme);
    loadServers().then(() => refreshSpaces());
    let unlisten = () => {};
    listenFeeds().then((off) => (unlisten = off)).catch(() => {});
    const timer = setInterval(poll, 5000);
    return () => {
      clearInterval(timer);
      unlisten();
      mq.removeEventListener("change", onScheme);
    };
  });

  const NAV: { route: Route; label: string; icon: string; key: string }[] = [
    { route: { view: "dashboard" }, label: "Übersicht", icon: "▦", key: "1" },
    { route: { view: "agents" }, label: "Agents", icon: "◉", key: "2" },
    { route: { view: "spaces" }, label: "Spaces", icon: "❒", key: "3" },
  ];
  const isActive = (r: Route) =>
    nav.route.view === r.view || (r.view === "spaces" && nav.route.view === "space");

  // sidebar: my sessions grouped by server
  const mine = $derived(
    app.servers.map((s) => ({
      server: s,
      refs: mySessions.ids
        .filter((id) => id.startsWith(`${s.id}|`))
        .map((id) => findPane(s.id, id.slice(s.id.length + 1)))
        .filter((r) => !!r),
    })),
  );
  const current = $derived(nav.route.view === "agent" ? findPane(nav.route.server, nav.route.pane) : undefined);
  const mod = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl+";
</script>

<svelte:window onkeydown={onKey} />

<main>
  <aside>
    <div class="brand"><b>Hollr</b>
      <button class="icon" title={`${t("Neue Sitzung")} (${mod}N)`} disabled={!app.servers.length}
        onclick={() => (dialogs.newSession = {})}>＋</button>
    </div>
    <nav>
      {#each NAV as item}
        <button class="nav" class:active={isActive(item.route)} onclick={() => go(item.route)} title={`${mod}${item.key}`}>
          <span class="ico">{item.icon}</span>{t(item.label)}
        </button>
      {/each}
    </nav>
    <div class="list">
      {#each mine as group (group.server.id)}
        {#if group.refs.length}
          <div class="group"><span class="dot" class:bad={!!app.errors[group.server.id]}></span>{group.server.label}</div>
          {#each group.refs as r (r.id)}
            <button class="session" class:sel={nav.route.view === "agent" && nav.route.server === r.server.id && nav.route.pane === r.pane.pane}
              onclick={() => go({ view: "agent", server: r.server.id, pane: r.pane.pane })}>
              <span class="dot {r.pane.status}"></span>
              <span class="name">{tabName(r.tab.label, r.workspace.label)}</span>
              <span class="kind">{r.pane.agent ?? t("Terminal")} · {statusLabel(r.pane.status)}</span>
            </button>
          {/each}
        {/if}
      {/each}
    </div>
    <div class="bottom">
      {#each app.servers as s (s.id)}
        <button class="srv" title={app.errors[s.id] ?? s.label} onclick={() => go({ view: "serverinfo", server: s.id })}>
          <span class="dot" class:bad={!!app.errors[s.id]}></span>{s.label}
        </button>
      {/each}
      <button class="nav" class:active={nav.route.view === "settings"} onclick={() => go({ view: "settings" })} title={`${mod},`}>
        <span class="ico">⚙</span>{t("Einstellungen")}
      </button>
    </div>
  </aside>

  <section class="main">
    {#if nav.route.view === "agent"}
      {#if current}
        {#key `${nav.route.server}|${nav.route.pane}`}
          <AgentView server={nav.route.server} pane={current.pane} title={tabName(current.tab.label, current.workspace.label)}
            onClosed={() => { mySessions.remove(`${current.server.id}|${current.pane.pane}`); back(); refresh(); }} />
        {/key}
      {:else}
        <div class="empty">{app.loaded[nav.route.server] ? t("Sitzung nicht mehr vorhanden.") : t("Lädt …")}</div>
      {/if}
    {:else if nav.route.view === "agents"}
      <Agents />
    {:else if nav.route.view === "spaces"}
      <Spaces />
    {:else if nav.route.view === "space"}
      <SpaceDetail server={nav.route.server} ws={nav.route.ws} />
    {:else if nav.route.view === "settings"}
      <Settings page={nav.route.page} />
    {:else if nav.route.view === "serverinfo"}
      <ServerInfo server={nav.route.server} />
    {:else if nav.route.view === "tools"}
      <Tools server={nav.route.server} />
    {:else}
      <Dashboard />
    {/if}
  </section>
</main>

<Notifier />
{#if dialogs.pair}
  <PairDialog onClose={() => (dialogs.pair = false)} onPaired={() => { dialogs.pair = false; loadServers(); }} />
{/if}
{#if dialogs.newSession}
  <NewSessionDialog servers={app.servers} trees={app.trees} onClose={() => (dialogs.newSession = null)}
    onCreated={async (server, pane) => { dialogs.newSession = null; await refresh(); go({ view: "agent", server, pane }); }} />
{/if}
{#if dialogs.newSpace}
  <NewSpaceDialog preset={dialogs.newSpace} onClose={() => (dialogs.newSpace = null)} />
{/if}

<style>
  main { display: grid; grid-template-columns: 240px 1fr; height: 100vh; }
  aside { background: var(--side); border-right: 1px solid var(--border); display: flex; flex-direction: column; min-height: 0; }
  .brand { display: flex; justify-content: space-between; align-items: center; padding: 14px 14px 8px; font-size: 16px; }
  .icon { all: unset; cursor: pointer; width: 26px; height: 26px; display: grid; place-items: center; border-radius: 7px; color: var(--muted); font-size: 16px; }
  .icon:hover { background: var(--card); color: var(--fg); }
  nav { padding: 0 8px 8px; display: grid; gap: 1px; border-bottom: 1px solid var(--border); }
  .nav { all: unset; cursor: pointer; display: flex; align-items: center; gap: 9px; padding: 6px 8px; border-radius: 8px; color: var(--muted); }
  .nav:hover { background: var(--card); color: var(--fg); }
  .nav.active { background: color-mix(in srgb, var(--accent) 20%, transparent); color: var(--fg); }
  .ico { width: 16px; text-align: center; font-size: 13px; }
  .list { flex: 1; overflow-y: auto; padding: 4px 8px; }
  .group { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; padding: 10px 8px 4px; }
  .session { all: unset; cursor: pointer; display: grid; grid-template-columns: 10px 1fr; column-gap: 8px; padding: 5px 8px; border-radius: 8px; width: calc(100% - 16px); }
  .session:hover { background: var(--card); }
  .session.sel { background: color-mix(in srgb, var(--accent) 22%, transparent); }
  .session .dot { grid-row: span 2; align-self: center; }
  .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .kind { font-size: 11px; color: var(--dim); }
  .bottom { padding: 8px; border-top: 1px solid var(--border); display: grid; gap: 1px; }
  .srv { all: unset; cursor: pointer; display: flex; align-items: center; gap: 8px; padding: 4px 8px; font-size: 12px; color: var(--muted); border-radius: 8px; }
  .srv:hover { background: var(--card); color: var(--fg); }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--green); flex: none; }
  .dot.bad { background: var(--orange); }
  .dot.unknown { background: var(--dim); }
  .dot.working { background: var(--purple); }
  .dot.blocked { background: var(--orange); }
  .main { min-width: 0; min-height: 0; overflow: hidden; }
  .empty { height: 100%; display: grid; place-items: center; color: var(--muted); }
</style>
