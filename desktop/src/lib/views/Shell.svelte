<script lang="ts">
  import { alertAsk } from "$lib/ask.svelte";
  // Hollr desktop shell (the main window): sidebar (navigation + my sessions) and the current view on the right.
  import { onMount, untrack } from "svelte";
  import { t } from "$lib/i18n";
  import { settings } from "$lib/settings.svelte";
  import {
    allPanes, app, back, dialogs, drafts, findPane, go, listenFeeds, loadServers, mySessions, nav, poll, refresh, refreshSpaces, tabName,
  } from "$lib/store.svelte";
  import SpacesSidebar from "$lib/components/SpacesSidebar.svelte";
  import WorkspaceTabs from "$lib/components/WorkspaceTabs.svelte";
  import ServerTabs from "$lib/components/ServerTabs.svelte";
  import LivePill from "$lib/components/LivePill.svelte";
  import AgentView from "$lib/components/AgentView.svelte";
  import PairDialog from "$lib/components/PairDialog.svelte";
  import * as api from "$lib/api";
  import { currentServer } from "$lib/currentServer.svelte";
  import Dashboard from "$lib/views/Dashboard.svelte";
  import Agents from "$lib/views/Agents.svelte";
  import Spaces from "$lib/views/Spaces.svelte";
  import SpaceDetail from "$lib/views/SpaceDetail.svelte";
  import Settings from "$lib/views/Settings.svelte";
  import ServerInfo from "$lib/views/ServerInfo.svelte";
  import Tools from "$lib/views/Tools.svelte";
  import Plugins from "$lib/views/Plugins.svelte";
  import PluginView from "$lib/views/PluginView.svelte";
  import NewSpaceDialog from "$lib/views/NewSpaceDialog.svelte";
  import Notifier from "$lib/views/Notifier.svelte";
  import AppLock from "$lib/components/AppLock.svelte";
  import TipsTour from "$lib/components/TipsTour.svelte";
  import ReadAloud from "$lib/components/ReadAloud.svelte";
  import AskDialog from "$lib/components/AskDialog.svelte";
  import { startDiagnostics } from "$lib/diag";
  startDiagnostics();
  import CommandPalette from "$lib/components/CommandPalette.svelte";
  import Icon from "$lib/components/git/Icon.svelte";
  import { pendingTips, tour } from "$lib/tips.svelte";
  import { inbox, inboxEntries, markSeen, trackInbox } from "$lib/inbox.svelte";

  const zoomBy = (d: number) => (settings.zoom = Math.round(Math.min(1.6, Math.max(0.7, settings.zoom + d)) * 100) / 100);

  function onKey(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    // ⌘⌥1…9 switch servers (ServerTabs)
    if (!mod || e.altKey) return;
    const k = e.key;
    if (k === "=" || k === "+") zoomBy(0.1);
    else if (k === "-") zoomBy(-0.1);
    else if (k === "0") settings.zoom = 1;
    else if (k === "n" && app.servers.length) dialogs.newSession = {};
    else if (k === "k") palette = !palette;
    else if (k === ",") go({ view: "settings" });
    else if (k === "1") go({ view: "dashboard" });
    // ⌘[ while typing belongs to the text field (drafts keep the text on the other shortcuts)
    else if (k === "[" && !typing(e.target)) back();
    else return;
    e.preventDefault();
  }

  const typing = (el: EventTarget | null) =>
    el instanceof HTMLElement && (el.matches("input, textarea, select") || el.isContentEditable);

  /** a closed session: forget it, and leave its view if it is still showing */
  function onClosed(id: string) {
    mySessions.remove(id);
    const r = nav.route;
    if (r.view === "agent" && `${r.server}|${r.pane}` === id) back();
    refresh();
  }

  onMount(() => {
    loadServers().then(() => refreshSpaces());
    tour.tips = pendingTips();
    let unlisten = () => {};
    listenFeeds().then((off) => (unlisten = off)).catch(() => {});
    const timer = setInterval(poll, 5000);
    return () => {
      clearInterval(timer);
      unlisten();
    };
  });

  // "Braucht dich": note when agents start waiting (on every tree refresh); the count goes on the Übersicht item
  $effect(() => {
    for (const s of app.servers) void app.trees[s.id];
    untrack(() => trackInbox());
  });
  const needsYou = $derived(inboxEntries().length);

  // the session in front of the user: its result counts as seen on every device ("Braucht dich" drops it here and
  // on the phone). Re-run on every tree refresh and inbox tick, so a result that comes in while it's open is seen
  // too. Navigating to a session also uses up its hand-made "unread" mark (not the re-runs while it stays open).
  let lastOpened = "";
  $effect(() => {
    const r = nav.route;
    void inbox.now;
    if (r.view !== "agent" && r.view !== "space") return void (lastOpened = "");
    void app.trees[r.server];
    if (document.visibilityState !== "visible") return;
    untrack(() => {
      const panes = allPanes(r.server)
        .filter((p) => (r.view === "agent" ? p.pane.pane === r.pane : p.workspace.id === r.ws))
        .map((p) => p.pane);
      if (!panes.length) return; // not loaded yet: the next tree refresh comes back here
      const key = r.view === "agent" ? `a|${r.server}|${r.pane}` : `s|${r.server}|${r.ws}`;
      markSeen(r.server, panes, key !== lastOpened);
      lastOpened = key;
    });
  });

  // Übersicht and ⌘K are the whole navigation: sessions and spaces live in the sidebar below, the old "Agents" and
  // "Spaces" lists stay reachable through the command palette
  let palette = $state(false);

  const current = $derived(nav.route.view === "agent" ? findPane(nav.route.server, nav.route.pane) : undefined);
  // the space was closed or taken off the list: don't keep its terminal on screen
  $effect(() => {
    const r = nav.route;
    if (r.view === "agent") {
      if (!app.loaded[r.server]) return;
      void app.trees[r.server];
      if (!findPane(r.server, r.pane)) untrack(() => go({ view: "dashboard" }));
    } else if (r.view === "space") {
      const list = app.spaces[r.server] as { id: string }[] | undefined;
      if (list && !list.some((s) => s.id === r.ws)) untrack(() => go({ view: "dashboard" }));
    }
  });
  /** the space view's herdr workspace, for its tab bar (none while the tree loads or nothing runs there) */
  const spaceWs = $derived.by(() => {
    const r = nav.route;
    return r.view === "space" ? app.trees[r.server]?.find((w) => w.id === r.ws) : undefined;
  });
  const mod = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl+";

  // ---- sidebar width: drag its right edge (double-click resets), remembered per computer
  const SW = "hollr.sidebarWidth";
  const SIDE_DEFAULT = 270;
  let sideWidth = $state(Number(localStorage.getItem(SW)) || SIDE_DEFAULT);
  const clampSide = (w: number) => Math.round(Math.min(Math.max(w, 200), Math.min(640, window.innerWidth * 0.5)));
  const saveSide = () => {
    try {
      localStorage.setItem(SW, String(sideWidth));
    } catch {}
  };
  function startSideResize(e: PointerEvent) {
    const startX = e.clientX;
    const start = sideWidth;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => (sideWidth = clampSide(start + ev.clientX - startX));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      saveSide();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  }

  // „Neue Sitzung“: no dialog – a terminal tab right away, in the current space (else a new one in ~)
  let opening = false;
  $effect(() => {
    const req = dialogs.newSession;
    if (!req) return;
    untrack(() => {
      dialogs.newSession = null;
      if (opening) return;
      const r = nav.route;
      const server = req.server ?? (r.view === "agent" || r.view === "space" ? r.server : currentServer());
      if (!server) return;
      const ws = req.ws ?? (r.view === "space" && r.server === server ? r.ws
        : r.view === "agent" && r.server === server ? findPane(server, r.pane)?.workspace.id : undefined);
      opening = true;
      api.newChat(server, { kind: "shell", label: t("Terminal"), ...(ws ? { workspace: ws } : {}) })
        .then(async (pane) => { await refresh(server); go({ view: "agent", server, pane }); })
        .catch((e) => void alertAsk(t("Fehler"), e instanceof Error ? e.message : String(e)))
        .finally(() => (opening = false));
    });
  });
</script>

<!-- files dropped next to the composer must not replace the app with the file (drop target: Composer) -->
<svelte:window onkeydown={onKey} ondragover={(e) => e.dataTransfer?.types.includes("Files") && e.preventDefault()}
  ondrop={(e) => e.dataTransfer?.types.includes("Files") && e.preventDefault()} />

<main style:grid-template-columns="{sideWidth}px 1fr">
  <aside>
    <div class="brand"><b>Hollr</b>
      <button class="icon" title={`${t("Neue Sitzung")} (${mod}N)`} aria-label={t("Neue Sitzung")} disabled={!app.servers.length}
        onclick={() => (dialogs.newSession = {})}><Icon name="plus" size={15} /></button>
    </div>
    <nav>
      <button class="nav" class:active={nav.route.view === "dashboard"} onclick={() => go({ view: "dashboard" })}>
        <span class="ico"><Icon name="grid" size={15} /></span><span class="grow">{t("Übersicht")}</span>
        {#if needsYou}<span class="count" title={t("Braucht dich")}>{needsYou}</span>{:else}<kbd>{mod}1</kbd>{/if}
      </button>
      <button class="nav" onclick={() => (palette = true)}>
        <span class="ico"><Icon name="find" size={15} /></span><span class="grow">{t("Suchen …")}</span><kbd>{mod}K</kbd>
      </button>
      <button class="nav" class:active={nav.route.view === "plugins" || nav.route.view === "plugin"} onclick={() => go({ view: "plugins" })}>
        <span class="ico"><Icon name="list" size={15} /></span><span class="grow">{t("Plugins")}</span>
      </button>
    </nav>
    <ServerTabs />
    <div class="list">
      <SpacesSidebar />
    </div>
    <div class="bottom">
      <LivePill />
      <button class="nav" class:active={nav.route.view === "settings"} onclick={() => go({ view: "settings" })}>
        <span class="ico"><Icon name="sliders" size={15} /></span><span class="grow">{t("Einstellungen")}</span><kbd>{mod},</kbd>
      </button>
    </div>
    <div class="sidegrip" role="separator" aria-orientation="vertical" aria-label={t("Seitenleiste breiter / schmaler")}
      title={t("Ziehen: Breite ändern · Doppelklick: zurücksetzen")} onpointerdown={startSideResize}
      ondblclick={() => { sideWidth = SIDE_DEFAULT; saveSide(); }}></div>
  </aside>

  <section class="main">
    <div class="view">
      {#if nav.route.view === "agent"}
        {#if current}
          <!-- the session renders its space's tab bar itself: its tools (Chat/Terminal, Git, Browser, Info) sit in it -->
          {#key `${nav.route.server}|${nav.route.pane}`}
            <AgentView server={nav.route.server} pane={current.pane} workspace={current.workspace} title={tabName(current.tab.label, current.workspace.label)}
              open={nav.route.open} url={nav.route.url} {onClosed} />
          {/key}
        {:else}
          <div class="empty">{app.loaded[nav.route.server] ? t("Sitzung nicht mehr vorhanden.") : t("Lädt …")}</div>
        {/if}
      {:else if nav.route.view === "agents"}
        <Agents />
      {:else if nav.route.view === "spaces"}
        <Spaces />
      {:else if nav.route.view === "space"}
        <div class="agentwrap">
          <div>{#if spaceWs}<WorkspaceTabs server={nav.route.server} workspace={spaceWs} />{/if}</div>
          <SpaceDetail server={nav.route.server} ws={nav.route.ws} />
        </div>
      {:else if nav.route.view === "settings"}
        <Settings page={nav.route.page} />
      {:else if nav.route.view === "serverinfo"}
        <ServerInfo server={nav.route.server} />
      {:else if nav.route.view === "tools"}
        <Tools server={nav.route.server} />
      {:else if nav.route.view === "plugins"}
        <Plugins />
      {:else if nav.route.view === "plugin"}
        {#key `${nav.route.server}|${nav.route.id}`}
          <PluginView server={nav.route.server} id={nav.route.id} />
        {/key}
      {:else}
        <Dashboard />
      {/if}
    </div>
  </section>
</main>

<Notifier />
<!-- read aloud: the button next to selected chat / terminal text, ⌘⇧S, the stop pill -->
<ReadAloud />
<AskDialog />
{#if dialogs.pair}
  <PairDialog onClose={() => (dialogs.pair = false)} onPaired={() => { dialogs.pair = false; loadServers(); }} />
{/if}
{#if dialogs.newSpace}
  <NewSpaceDialog preset={dialogs.newSpace} onClose={() => (dialogs.newSpace = null)} />
{/if}
{#if palette}
  <CommandPalette onClose={() => (palette = false)} />
{/if}
{#if tour.tips}
  <TipsTour tips={tour.tips} onClose={() => (tour.tips = null)} />
{/if}
<!-- last: covers everything above while locked -->
<AppLock />

<style>
  main { display: grid; grid-template-columns: 260px 1fr; height: 100vh; }
  aside { position: relative; background: var(--side); border-right: 1px solid var(--border); display: flex; flex-direction: column; min-height: 0; min-width: 0; }
  .sidegrip { position: absolute; top: 0; bottom: 0; right: -3px; width: 6px; cursor: col-resize; z-index: 5; }
  .sidegrip:hover, .sidegrip:active { background: color-mix(in srgb, var(--accent) 60%, transparent); }
  .brand { display: flex; justify-content: space-between; align-items: center; padding: 14px 12px 10px 18px; font-size: 16px; }
  .icon { all: unset; cursor: pointer; width: 26px; height: 26px; display: grid; place-items: center; border-radius: 7px; color: var(--muted); }
  .icon:focus-visible, .nav:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .icon:hover { background: var(--card); color: var(--fg); }
  nav { padding: 0 8px 10px; display: grid; gap: 2px; border-bottom: 1px solid var(--border); }
  .nav { all: unset; cursor: pointer; display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-radius: 8px; color: var(--muted); }
  .nav kbd { font: 11px var(--mono); color: var(--dim); }
  .nav:hover { background: var(--card); color: var(--fg); }
  .nav.active { background: color-mix(in srgb, var(--accent) 20%, transparent); color: var(--fg); }
  .count { min-width: 18px; height: 18px; padding: 0 5px; box-sizing: border-box; border-radius: 9px; display: grid; place-items: center;
    font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--bg); background: var(--orange); }
  .ico { width: 16px; display: grid; place-items: center; }
  .list { flex: 1; overflow-y: auto; padding: 4px 8px; display: flex; flex-direction: column; }
  .bottom { padding: 8px; border-top: 1px solid var(--border); display: grid; gap: 1px; }
  .main { min-width: 0; min-height: 0; overflow: hidden; display: grid; grid-template-rows: minmax(0, 1fr); }
  .view { min-width: 0; min-height: 0; overflow: hidden; display: grid; grid-template-rows: minmax(0, 1fr); }
  .agentwrap { display: grid; grid-template-rows: auto minmax(0, 1fr); height: 100%; min-height: 0; }
  .empty { height: 100%; display: grid; place-items: center; color: var(--muted); }
</style>
