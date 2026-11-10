<script lang="ts">
  // herdr's "Open worktree": every checkout of the repo, type to filter, Enter opens it.
  // One that already has a space is just shown ("offen") and selected instead of opened twice.
  import { onMount, tick } from "svelte";
  import Modal from "./Modal.svelte";
  import { t } from "$lib/i18n";
  import { go, lastTabRoute, refresh, refreshSpaces } from "$lib/store.svelte";
  import { space, worktreeCheckouts, type WorktreeCheckout } from "$lib/views/spaces/spaces";

  let { server, ws, onClose }: { server: string; ws: string; onClose: () => void } = $props();

  let rows = $state<WorktreeCheckout[]>([]);
  let query = $state("");
  let error = $state("");
  let busy = $state("");
  let picked = $state(0);

  const shown = $derived(
    rows.filter((r) => {
      const q = query.trim().toLowerCase();
      return !q || r.branch.toLowerCase().includes(q) || r.path.toLowerCase().includes(q) || r.label.toLowerCase().includes(q);
    }),
  );

  onMount(() => {
    worktreeCheckouts(server, ws)
      .then((r) => (rows = r.worktrees))
      .catch((e) => (error = e instanceof Error ? e.message : String(e)));
  });

  async function choose(row: WorktreeCheckout) {
    if (busy) return;
    if (row.open) {
      onClose();
      go(lastTabRoute(server, row.open) ?? { view: "space", server, ws: row.open });
      return;
    }
    busy = row.path;
    error = "";
    try {
      const r = await space(server, { op: "open", ws, cwd: row.path });
      await Promise.all([refreshSpaces(server), refresh()]);
      onClose();
      if (r.pane) go({ view: "agent", server, pane: r.pane });
      else if (r.ws) go({ view: "space", server, ws: r.ws });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      busy = "";
    }
  }

  const focus = (node: HTMLInputElement) => { void tick().then(() => node.focus()); };

  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); picked = Math.min(shown.length - 1, picked + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); picked = Math.max(0, picked - 1); }
    else if (e.key === "Enter" && shown[picked]) { e.preventDefault(); void choose(shown[picked]); }
  }
</script>

<Modal icon="⑂" title={t("Worktree öffnen …")} {onClose} width={640}>
  <input class="q" placeholder={t("Filtern …")} bind:value={query} oninput={() => (picked = 0)} onkeydown={onKey} use:focus />
  <div class="list" role="listbox">
    {#each shown as row, i (row.path)}
      <button class="row" class:on={i === picked} role="option" aria-selected={i === picked} disabled={!!busy}
        onclick={() => void choose(row)}>
        <span class="branch">{row.branch || row.label}</span>
        <span class="path">{row.path}</span>
        {#if row.open}<span class="badge">{t("bereits offen")}</span>{/if}
      </button>
    {:else}
      <div class="empty">{error || t("Keine Worktrees")}</div>
    {/each}
  </div>
  {#if error && shown.length}<div class="err">{error}</div>{/if}
</Modal>

<style>
  .q { width: 100%; box-sizing: border-box; font: 13px var(--mono); padding: 7px 10px; border-radius: 8px;
    border: 1px solid var(--border); background: var(--bg); color: var(--fg); }
  .list { display: grid; gap: 2px; max-height: 50vh; overflow: auto; margin-top: 8px; }
  .row { all: unset; cursor: pointer; display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; padding: 6px 8px; border-radius: 8px; }
  .row.on, .row:hover { background: color-mix(in srgb, var(--accent) 16%, transparent); }
  .branch { font-weight: 600; }
  .path { grid-column: 1 / -1; font: 11.5px var(--mono); color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { font-size: 11px; color: var(--muted); }
  .empty, .err { font-size: 12.5px; color: var(--muted); padding: 8px; }
  .err { color: var(--orange); }
</style>
