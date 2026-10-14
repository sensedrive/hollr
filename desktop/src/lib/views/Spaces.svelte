<script lang="ts">
  // herdr's "spaces" sidebar: repos with main checkout + worktrees, standalone workspaces.
  import { onMount } from "svelte";
  import { t } from "$lib/i18n";
  import { app, dialogs, go, refreshSpaces } from "$lib/store.svelte";
  import ContextMenu from "./dashboard/ContextMenu.svelte";
  import { arrowNav, type MenuItem } from "./dashboard/util";
  import SpaceRow from "./spaces/SpaceRow.svelte";
  import CloseSpaceDialog from "./spaces/CloseSpaceDialog.svelte";
  import NewSpaceDialog from "./NewSpaceDialog.svelte";
  import { groupSpaces, type FullSpace } from "./spaces/spaces";

  onMount(() => {
    refreshSpaces();
    const timer = setInterval(() => refreshSpaces(), 10_000);
    return () => clearInterval(timer);
  });

  let closing = $state<{ server: string; space: FullSpace } | null>(null);
  let worktreeOf = $state<{ server: string; repo: string } | null>(null);
  let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);
  let reloading = $state(false);

  const sections = $derived(
    app.servers.map((s) => ({
      server: s,
      loaded: app.spaces[s.id] !== undefined,
      groups: groupSpaces((app.spaces[s.id] ?? []) as FullSpace[]),
    })),
  );

  function rowMenu(e: MouseEvent, server: string, sp: FullSpace) {
    menu = {
      x: e.clientX, y: e.clientY,
      items: [
        { label: t("Öffnen"), icon: "↗", action: () => go({ view: "space", server, ws: sp.id }) },
        { label: t("Neue Sitzung hier"), icon: "＋", action: () => (dialogs.newSession = { server, ws: sp.id }) },
        ...(!sp.isWorktree && sp.git ? [{ label: t("Neuer Worktree …"), icon: "⑂", action: () => (worktreeOf = { server, repo: sp.id }) }] : []),
        { label: sp.isWorktree ? t("Schließen / Worktree löschen …") : t("Space schließen …"), icon: "✕", danger: true,
          action: () => (closing = { server, space: sp }) },
      ],
    };
  }

  async function reload() { reloading = true; await refreshSpaces(); reloading = false; }
</script>

<div class="page">
  <div class="page-head">
    <h1>{t("Spaces")}</h1>
    <button class="btn" disabled={reloading} onclick={reload} title={t("Aktualisieren")}>{reloading ? "…" : "↻"}</button>
    <button class="btn primary" disabled={!app.servers.length} onclick={() => (dialogs.newSpace = {})}>＋ {t("Neuer Space")}</button>
  </div>

  <div use:arrowNav>
    {#each sections as sec (sec.server.id)}
      {#if app.servers.length > 1}
        <div class="section">{sec.server.label}</div>
      {/if}
      {#if app.errors[sec.server.id] && !sec.loaded}
        <div class="small" style="color:var(--orange)">⚠ {app.errors[sec.server.id]}</div>
      {:else if !sec.loaded}
        <div class="rows">
          {#each [170, 220, 140, 200, 160] as w, i}
            <div class="row" style="display:grid; gap:7px">
              <div class="skeleton" style="height:14px; width:{w}px"></div>
              <div class="skeleton" style="height:10px; width:{[120, 90, 150, 110, 80][i]}px"></div>
            </div>
          {/each}
        </div>
      {:else if !sec.groups.length}
        <div class="card muted">{t("Keine Spaces auf diesem Server.")}</div>
      {:else}
        <div class="rows">
          {#each sec.groups as g (g.key)}
            {#each g.spaces as sp, i (sp.id)}
              <SpaceRow space={sp} nested={g.key !== sp.id && i > 0} last={i === g.spaces.length - 1}
                onOpen={() => go({ view: "space", server: sec.server.id, ws: sp.id })}
                onClose={() => (closing = { server: sec.server.id, space: sp })}
                onMenu={(e) => rowMenu(e, sec.server.id, sp)} />
            {/each}
          {/each}
        </div>
      {/if}
    {/each}
  </div>
</div>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => (menu = null)} />
{/if}
{#if closing}
  <CloseSpaceDialog server={closing.server} space={closing.space} onClose={() => (closing = null)} />
{/if}
{#if worktreeOf}
  <NewSpaceDialog preset={worktreeOf} onClose={() => (worktreeOf = null)} />
{/if}
