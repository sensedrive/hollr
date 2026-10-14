<script lang="ts">
  // Übersicht: the sessions you opened in Hollr (grouped by machine, live previews),
  // usage limits and the paired servers.
  import { onMount } from "svelte";
  import * as api from "$lib/api";
  import type { Server } from "$lib/api";
  import { t } from "$lib/i18n";
  import {
    app, dialogs, findPane, go, loadServers, mySessions, refresh, type PaneRef,
  } from "$lib/store.svelte";
  import SessionCard from "./dashboard/SessionCard.svelte";
  import ContextMenu from "./dashboard/ContextMenu.svelte";
  import ConfirmDialog from "./dashboard/ConfirmDialog.svelte";
  import LimitsDialog from "./dashboard/LimitsDialog.svelte";
  import { providerName, refreshUsage, usage, usedColor } from "./dashboard/usage.svelte";
  import { arrowNav, refTitle, type MenuItem } from "./dashboard/util";

  onMount(() => {
    const timer = setInterval(() => refreshUsage(), 120_000);
    return () => clearInterval(timer);
  });
  // load as soon as the paired servers are known (on app start they come in after mount)
  $effect(() => {
    if (app.servers.length) refreshUsage();
  });

  const anyLoaded = $derived(app.servers.some((s) => app.loaded[s.id]));
  const mine = $derived(
    mySessions.ids
      .map((id) => {
        const i = id.indexOf("|");
        return findPane(id.slice(0, i), id.slice(i + 1));
      })
      .filter((r): r is PaneRef => !!r),
  );
  const groups = $derived(
    app.servers.map((server) => ({ server, refs: mine.filter((r) => r.server.id === server.id) })).filter((g) => g.refs.length),
  );

  // one quiet line: "Claude 5h 2% 7d 64%  ChatGPT 5h 1% 7d 5%" (pooled over all accounts)
  const caps = $derived(
    app.servers
      .flatMap((s) => usage.capacity[s.id] ?? [])
      .filter((c) => (!c.meter || c.meter === "chat") && ["anthropic", "openai-codex"].includes(c.provider)),
  );
  const capGroups = $derived(
    [...new Set(caps.map((c) => c.provider))].sort().map((p) => ({ provider: p, rows: caps.filter((c) => c.provider === p) })),
  );

  let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);
  let ending = $state<PaneRef | null>(null);
  let removing = $state<Server | null>(null);
  let showLimits = $state(false);
  let reloading = $state(false);

  const open = (r: PaneRef) => go({ view: "agent", server: r.server.id, pane: r.pane.pane });

  function cardMenu(e: MouseEvent, r: PaneRef) {
    menu = {
      x: e.clientX, y: e.clientY,
      items: [
        { label: t("Öffnen"), icon: "↗", action: () => open(r) },
        { label: t("Aus der Übersicht nehmen"), icon: "◌", action: () => mySessions.remove(r.id) },
        { label: t("Sitzung beenden"), icon: "✕", danger: true, action: () => (ending = r) },
      ],
    };
  }

  function serverMenu(e: MouseEvent, s: Server) {
    e.preventDefault();
    menu = {
      x: e.clientX, y: e.clientY,
      items: [
        { label: t("Server-Info"), icon: "ⓘ", action: () => go({ view: "serverinfo", server: s.id }) },
        { label: t("Werkzeuge"), icon: "⚒", action: () => go({ view: "tools", server: s.id }) },
        { label: t("Entfernen"), icon: "✕", danger: true, action: () => (removing = s) },
      ],
    };
  }

  async function endSession(r: PaneRef) {
    await api.closePane(r.server.id, r.pane.pane);
    mySessions.remove(r.id);
    ending = null;
    await refresh();
  }

  async function removeServer(s: Server) {
    await api.removeServer(s.id);
    removing = null;
    await loadServers();
  }

  async function reload() {
    reloading = true;
    await Promise.all([refresh(), refreshUsage(true)]);
    reloading = false;
  }

  const address = (s: Server) => `${s.user}@${s.addresses[0] ?? "?"}`;
</script>

<div class="page">
  <div class="page-head">
    <h1>{t("Übersicht")}</h1>
    <button class="btn" disabled={reloading} onclick={reload} title={t("Aktualisieren")}>{reloading ? "…" : "↻"}</button>
    <button class="btn primary" disabled={!app.servers.length} onclick={() => (dialogs.newSession = {})}>＋ {t("Neue Sitzung")}</button>
  </div>

  {#if capGroups.length}
    <button class="limits" onclick={() => (showLimits = true)} title={t("Nutzungslimits")}>
      {#each capGroups as g}
        <span class="lg"><span class="muted">{providerName(g.provider)}</span>
          {#each g.rows as c}<span style="color:{usedColor(c.used, true)}">{c.window} {Math.round(c.used * 100)}%</span>{/each}
        </span>
      {/each}
      <span class="grow"></span><span class="dim">›</span>
    </button>
  {/if}

  <!-- sessions -->
  {#if !mine.length && !anyLoaded && mySessions.ids.length}
    <div class="skeleton" style="width:120px; height:12px; margin: 22px 0 14px"></div>
    <div class="grid">
      {#each Array(Math.min(4, mySessions.ids.length)) as _}
        <div><div class="skeleton" style="height:160px; border-radius:12px"></div>
          <div class="skeleton" style="height:12px; width:60%; margin-top:10px"></div></div>
      {/each}
    </div>
  {:else if !mine.length}
    <div class="section">{t("Sitzungen")}</div>
    <div class="empty card">
      <div class="muted">{t("Hier erscheinen die Sitzungen, die du in Hollr öffnest oder startest – Agents und Terminals, nach Maschine sortiert.")}</div>
      <div class="row-buttons">
        <button class="btn primary" disabled={!app.servers.length} onclick={() => (dialogs.newSession = {})}>＋ {t("Neue Sitzung")}</button>
        <button class="btn" onclick={() => go({ view: "agents" })}>{t("Alle Agents")}</button>
      </div>
    </div>
  {/if}

  {#each groups as g (g.server.id)}
    <div class="section head">
      <span class="sdot" class:bad={!!app.errors[g.server.id]}></span>
      <span class="grow">{g.server.label}</span><span class="dim">{g.refs.length}</span>
    </div>
    <div class="grid" use:arrowNav>
      {#each g.refs as r (r.id)}
        <SessionCard ref={r} onOpen={() => open(r)} onMenu={(e) => cardMenu(e, r)}
          onHide={() => mySessions.remove(r.id)} onEnd={() => (ending = r)} />
      {/each}
    </div>
  {/each}

  <!-- connections -->
  <div class="section">{t("Verbindungen")}</div>
  <div class="servers" use:arrowNav>
    {#each app.servers as s (s.id)}
      <button class="srv card" data-nav onclick={() => go({ view: "serverinfo", server: s.id })} oncontextmenu={(e) => serverMenu(e, s)}
        title={app.errors[s.id] ?? ""}>
        <span class="rack">▤</span>
        <span class="grow">
          <span class="lbl ellipsis">{s.label}</span>
          <span class="addr mono ellipsis">{address(s)}</span>
          {#if app.errors[s.id]}<span class="small ellipsis" style="color:var(--orange)">{app.errors[s.id]}</span>{/if}
        </span>
        <span class="sdot big" class:bad={!!app.errors[s.id]} class:unknown={!app.loaded[s.id]}></span>
        <span class="dim">›</span>
      </button>
    {/each}
    <button class="srv card pair" data-nav onclick={() => (dialogs.pair = true)}>
      <span class="rack">⌗</span><span class="grow">{t("Server koppeln")}</span>
    </button>
  </div>
</div>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => (menu = null)} />
{/if}
{#if ending}
  {@const r = ending}
  <ConfirmDialog title={t("Sitzung beenden?")} confirmLabel={t("Sitzung beenden")}
    message={t("„{title}“ wird in herdr geschlossen und {agent} beendet.", { title: refTitle(r), agent: r.pane.agent ?? "Shell" })}
    onConfirm={() => endSession(r)} onClose={() => (ending = null)} />
{/if}
{#if removing}
  {@const s = removing}
  <ConfirmDialog title={t("Server aus Hollr entfernen?")} confirmLabel={t("Entfernen")}
    message={t("Auf dem Server bleibt der Schlüssel bis `hollr revoke {id}`.", { id: s.deviceId })}
    onConfirm={() => removeServer(s)} onClose={() => (removing = null)} />
{/if}
{#if showLimits}
  <LimitsDialog onClose={() => (showLimits = false)} />
{/if}

<style>
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 18px 16px; }
  .head { display: flex; align-items: center; gap: 8px; }
  .sdot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); flex: none; }
  .sdot.big { width: 9px; height: 9px; }
  .sdot.bad { background: var(--orange); }
  .sdot.unknown { background: var(--dim); }
  .limits { all: unset; box-sizing: border-box; cursor: pointer; display: flex; align-items: center; gap: 16px; width: 100%;
    padding: 7px 12px; border-radius: 10px; font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; }
  .limits:hover, .limits:focus-visible { background: var(--card); }
  .lg { display: inline-flex; gap: 6px; }
  .empty { display: grid; gap: 12px; padding: 18px; max-width: 640px; }
  .row-buttons { display: flex; gap: 8px; }
  .servers { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px; }
  .srv { all: unset; box-sizing: border-box; cursor: pointer; display: flex; align-items: center; gap: 12px; padding: 12px 14px;
    background: var(--card); border: 1px solid var(--border); border-radius: 14px; transition: border-color .12s; }
  .srv:hover, .srv:focus-visible { border-color: var(--accent); }
  .srv .grow { display: grid; }
  .rack { width: 38px; height: 38px; flex: none; display: grid; place-items: center; border-radius: 10px; font-size: 17px;
    color: var(--accent); background: color-mix(in srgb, var(--accent) 15%, transparent); }
  .lbl { font-weight: 600; }
  .addr { font-size: 11px; color: var(--muted); }
  .pair { border-style: dashed; color: var(--muted); }
  .pair .rack { color: var(--muted); background: color-mix(in srgb, var(--fg) 6%, transparent); }
</style>
