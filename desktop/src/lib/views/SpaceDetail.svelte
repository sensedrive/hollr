<script lang="ts">
  // One space: its sessions (panes) on the left, the git panel (changes, history, branches, files) on the right.
  import GitPanel from "$lib/components/GitPanel.svelte";
  import * as api from "$lib/api";
  import { t } from "$lib/i18n";
  import { allPanes, app, back, dialogs, go, mySessions, refresh, refreshSpaces, type PaneRef } from "$lib/store.svelte";
  import AgentRow from "./dashboard/AgentRow.svelte";
  import ConfirmDialog from "./dashboard/ConfirmDialog.svelte";
  import ContextMenu from "./dashboard/ContextMenu.svelte";
  import { agentName, arrowNav, refTitle, relTime, statusColor, type MenuItem } from "./dashboard/util";
  import CloseSpaceDialog from "./spaces/CloseSpaceDialog.svelte";
  import NewSpaceDialog from "./NewSpaceDialog.svelte";
  import type { FullSpace } from "./spaces/spaces";

  let { server, ws }: { server: string; ws: string } = $props();

  $effect(() => {
    if (app.spaces[server] === undefined) refreshSpaces(server);
  });

  const space = $derived(((app.spaces[server] ?? []) as FullSpace[]).find((s) => s.id === ws));
  const workspace = $derived((app.trees[server] ?? []).find((w) => w.id === ws));
  const label = $derived(space?.label ?? workspace?.label ?? ws);
  const refs = $derived(allPanes(server).filter((r) => r.workspace.id === ws));
  const serverLabel = $derived(app.servers.find((s) => s.id === server)?.label ?? "");
  const gone = $derived(app.spaces[server] !== undefined && app.loaded[server] && !space && !workspace);

  let closing = $state(false);
  let newWorktree = $state(false);
  let closingPane = $state<PaneRef | null>(null);
  let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);
  let showGit = $state(true);

  function rowMenu(e: MouseEvent, r: PaneRef) {
    menu = {
      x: e.clientX, y: e.clientY,
      items: [
        { label: t("Öffnen"), icon: "↗", action: () => go({ view: "agent", server, pane: r.pane.pane }) },
        ...(mySessions.ids.includes(r.id)
          ? [{ label: t("Aus der Übersicht nehmen"), icon: "◌", action: () => mySessions.remove(r.id) }]
          : [{ label: t("Zur Übersicht hinzufügen"), icon: "▦", action: () => mySessions.touch(r.id) }]),
        { label: t("Schließen"), icon: "✕", danger: true, action: () => (closingPane = r) },
      ],
    };
  }

  async function closePane(r: PaneRef) {
    await api.closePane(server, r.pane.pane);
    mySessions.remove(r.id);
    closingPane = null;
    await Promise.all([refresh(), refreshSpaces(server)]);
  }
</script>

<div class="detail" class:nogit={!space?.git || !showGit}>
  <div class="left page">
    <div class="crumbs small"><button class="link" onclick={() => go({ view: "spaces" })}>{t("Spaces")}</button>
      {#if app.servers.length > 1}<span class="dim"> · {serverLabel}</span>{/if}</div>
    <div class="page-head">
      <span class="ring" style="--c:{statusColor(space?.status ?? 'unknown')}" class:fill={space?.status === "working"}></span>
      <h1 class="ellipsis">{label}</h1>
    </div>

    {#if gone}
      <div class="card muted">{t("Diesen Space gibt es nicht mehr.")}</div>
      <button class="btn" onclick={back}>{t("Zurück")}</button>
    {:else}
      <div class="meta">
        {#if space}
          <div class="mono small muted ellipsis" title={space.root}>{space.root}</div>
          {#if space.git}
            <div class="git mono small">
              <span style="color:var(--purple)">⑂ {space.git.branch}</span>
              {#if space.git.dirty > 0}<span style="color:var(--orange)">*{space.git.dirty}</span>{/if}
              {#if space.git.ahead > 0}<span style="color:var(--green)">↑{space.git.ahead}</span>{/if}
              {#if space.git.behind > 0}<span style="color:var(--red)">↓{space.git.behind}</span>{/if}
              {#if space.isWorktree}<span class="pill">worktree</span>{/if}
            </div>
            {#if space.git.lastCommit}
              <div class="small dim ellipsis">{space.git.lastCommit.subject} · {relTime(space.git.lastCommit.at)}</div>
            {/if}
          {/if}
        {:else}
          <div class="skeleton" style="height:12px; width:70%"></div>
          <div class="skeleton" style="height:12px; width:40%"></div>
        {/if}
      </div>

      <div class="actions">
        <button class="btn primary" onclick={() => (dialogs.newSession = { server, ws })}>＋ {t("Neue Sitzung")}</button>
        {#if space && !space.isWorktree && space.git}
          <button class="btn" onclick={() => (newWorktree = true)}>⑂ {t("Neuer Worktree …")}</button>
        {/if}
        {#if space?.git}
          <button class="btn" onclick={() => (showGit = !showGit)}>{showGit ? t("Git ausblenden") : t("Git anzeigen")}</button>
        {/if}
        <button class="btn danger" disabled={!space} onclick={() => (closing = true)}>
          {space?.isWorktree ? t("Schließen / Worktree löschen …") : t("Space schließen …")}</button>
      </div>

      <div class="section">{t("Sitzungen")} <span class="dim">· {refs.length}</span></div>
      {#if !app.loaded[server]}
        <div class="rows">{#each Array(3) as _}<div class="row"><div class="skeleton" style="height:38px; width:100%"></div></div>{/each}</div>
      {:else if !refs.length}
        <div class="card muted small">{t("Keine Panes")}</div>
      {:else}
        <div class="rows" use:arrowNav>
          {#each refs as r (r.id)}
            <AgentRow ref={r} onClose={() => (closingPane = r)} onMenu={(e) => rowMenu(e, r)} />
          {/each}
        </div>
      {/if}
    {/if}
  </div>

  {#if space?.git && showGit && !gone}
    <div class="right">
      {#key ws}<GitPanel {server} {ws} />{/key}
    </div>
  {/if}
</div>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => (menu = null)} />
{/if}
{#if closing && space}
  <CloseSpaceDialog {server} {space} onClose={() => (closing = false)} onClosed={() => go({ view: "spaces" })} />
{/if}
{#if newWorktree}
  <NewSpaceDialog preset={{ server, repo: ws }} onClose={() => (newWorktree = false)} />
{/if}
{#if closingPane}
  {@const r = closingPane}
  <ConfirmDialog title={t("Chat schließen?")} confirmLabel={t("Schließen")}
    message={t("„{title}“ wird in herdr geschlossen und {agent} beendet.", { title: refTitle(r), agent: agentName(r.pane) })}
    onConfirm={() => closePane(r)} onClose={() => (closingPane = null)} />
{/if}

<style>
  .detail { display: grid; grid-template-columns: minmax(320px, 420px) 1fr; height: 100%; min-height: 0; }
  .detail.nogit { grid-template-columns: 1fr; }
  .detail.nogit .left { max-width: 900px; }
  .left { border-right: 1px solid var(--border); }
  .nogit .left { border-right: 0; }
  .right { min-width: 0; min-height: 0; overflow: hidden; }
  .crumbs { margin-bottom: 4px; }
  .link { all: unset; cursor: pointer; color: var(--muted); }
  .link:hover, .link:focus-visible { color: var(--accent); }
  .page-head { margin-bottom: 8px; }
  .ring { width: 12px; height: 12px; border-radius: 50%; border: 1.5px solid var(--c); flex: none; box-sizing: border-box; }
  .ring.fill { background: var(--c); }
  .meta { display: grid; gap: 4px; margin-bottom: 14px; }
  .git { display: flex; gap: 8px; align-items: center; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
