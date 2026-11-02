<script lang="ts">
  // herdr's tab bar for the open session's workspace: every tab (and every pane of a split tab) with its
  // number, name and status – one click switches, ＋ starts a new session in the same space.
  import { t } from "$lib/i18n";
  import { dialogs, go, type PaneRef } from "$lib/store.svelte";

  let { current }: { current: PaneRef } = $props();

  const ws = $derived(current.workspace);
  const server = $derived(current.server.id);

  /** a tab's name: its own label, else what runs in it (herdr numbers unnamed tabs) */
  function nameOf(tab: (typeof ws.tabs)[number], pane: (typeof ws.tabs)[number]["panes"][number]) {
    if (!/^(Tab )?\d+$/.test(tab.label)) return tab.label;
    return pane.agent ?? (pane.title && !/^\d+$/.test(pane.title) ? pane.title : t("Terminal"));
  }
</script>

<div class="tabs" role="tablist" aria-label={ws.label}>
  <button class="ws ellipsis" title={t("Space öffnen")} onclick={() => go({ view: "space", server, ws: ws.id })}>{ws.label}</button>
  <div class="strip">
    {#each ws.tabs as tab (tab.id)}
      {#each tab.panes as pane, i (pane.pane)}
        {@const on = pane.pane === current.pane.pane}
        <button class="tab" class:on class:split={i > 0} role="tab" aria-selected={on}
          title={pane.title || nameOf(tab, pane)} onclick={() => go({ view: "agent", server, pane: pane.pane })}>
          <span class="num">{i === 0 ? tab.number : "┊"}</span>
          <span class="dot {pane.status}"></span>
          <span class="name ellipsis">{nameOf(tab, pane)}</span>
        </button>
      {/each}
    {/each}
  </div>
  <button class="add" title={t("Neue Sitzung hier")} aria-label={t("Neue Sitzung hier")}
    onclick={() => (dialogs.newSession = { server, ws: ws.id })}>＋</button>
</div>

<style>
  .tabs { display: flex; align-items: stretch; gap: 2px; padding: 5px 10px 0; border-bottom: 1px solid var(--border);
    background: var(--side); font-family: var(--mono); font-size: 12px; min-width: 0; }
  .ws { all: unset; cursor: pointer; align-self: center; max-width: 160px; padding: 0 10px 5px 6px; color: var(--muted); font-weight: 600; }
  .ws:hover { color: var(--fg); }
  .strip { display: flex; gap: 2px; overflow-x: auto; min-width: 0; scrollbar-width: none; }
  .strip::-webkit-scrollbar { display: none; }
  .tab { all: unset; cursor: pointer; display: flex; align-items: center; gap: 6px; padding: 5px 12px 6px; max-width: 220px;
    border: 1px solid transparent; border-bottom: none; border-radius: 8px 8px 0 0; color: var(--muted); flex: none; }
  .tab:hover { color: var(--fg); background: color-mix(in srgb, var(--fg) 5%, transparent); }
  .tab.on { color: var(--fg); background: var(--bg); border-color: var(--border); margin-bottom: -1px; }
  .tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .tab.split { padding-left: 8px; }
  .num { color: var(--dim); }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; box-sizing: border-box; border: 1.5px solid var(--green); }
  .dot.working { background: var(--purple); border-color: var(--purple); }
  .dot.blocked { background: var(--orange); border-color: var(--orange); }
  .dot.done { background: var(--green); }
  .dot.unknown { width: 4px; height: 4px; border: none; background: var(--dim); }
  .add { all: unset; cursor: pointer; align-self: center; padding: 0 8px 5px; color: var(--muted); font-size: 14px; }
  .add:hover { color: var(--fg); }
  .ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
