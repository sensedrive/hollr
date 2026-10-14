<script lang="ts">
  // Moshi-style repo browser for one space: files, changes, history graph, branches.
  // Wide: list left, file/diff/commit right. Narrow: list, then the detail with a back button.
  import { t } from "../i18n";
  import BranchesTab from "./git/BranchesTab.svelte";
  import ChangesTab from "./git/ChangesTab.svelte";
  import CommitView from "./git/CommitView.svelte";
  import DiffPane from "./git/DiffPane.svelte";
  import FileViewer from "./git/FileViewer.svelte";
  import FilesTab from "./git/FilesTab.svelte";
  import HistoryTab from "./git/HistoryTab.svelte";
  import Icon from "./git/Icon.svelte";
  import { detailKey, type Detail, type Tab } from "./git/nav";

  let { server, ws, title = "", initialTab = "changes" }:
    { server: string; ws: string; title?: string; initialTab?: Tab } = $props();

  // svelte-ignore state_referenced_locally
  let tab = $state<Tab>(initialTab);
  let rev = $state(0);
  let width = $state(0);
  let details = $state<Record<Tab, Detail[]>>({ files: [], changes: [], history: [], branches: [] });

  const wide = $derived(width >= 820);
  const stack = $derived(details[tab]);
  const top = $derived(stack.at(-1));
  const openKey = $derived(detailKey(top));
  const hasDetail = $derived(tab !== "branches");

  // another space: start over
  let lastWs = "";
  $effect(() => {
    if (ws !== lastWs) { lastWs = ws; details = { files: [], changes: [], history: [], branches: [] }; }
  });

  const tabs: { k: Tab; icon: string; label: () => string }[] = [
    { k: "files", icon: "files", label: () => t("Dateien") },
    { k: "changes", icon: "changes", label: () => t("Änderungen") },
    { k: "history", icon: "history", label: () => t("Verlauf") },
    { k: "branches", icon: "branch", label: () => "Branches" },
  ];

  /** from a list: replaces the detail; from inside a detail (commit → file diff): pushes */
  const open = (d: Detail) => (details[tab] = [d]);
  const push = (d: Detail) => (details[tab] = [...details[tab], d]);
  const back = () => (details[tab] = details[tab].slice(0, -1));

  function staged(path: string, nowStaged: boolean) {
    const d = details.changes.at(-1);
    if (d?.k === "diff" && !d.hash && d.path === path) details.changes = [{ ...d, staged: nowStaged }];
    rev++;
  }

  function onkeydown(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (e.key === "Escape" && stack.length) { e.preventDefault(); back(); }
    else if ((e.metaKey || e.ctrlKey) && e.key === "r") { e.preventDefault(); rev++; }
    else if (!e.metaKey && !e.ctrlKey && !e.altKey && ["1", "2", "3", "4"].includes(e.key)) { tab = tabs[Number(e.key) - 1].k; }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="panel" bind:clientWidth={width} {onkeydown}>
  <nav class="bar">
    <div class="seg" role="tablist">
      {#each tabs as x, i}
        <button role="tab" aria-selected={tab === x.k} class:on={tab === x.k} onclick={() => (tab = x.k)} title={`${x.label()} (${i + 1})`}>
          <Icon name={x.icon} size={15} /><span>{x.label()}</span>
        </button>
      {/each}
    </div>
    <button class="icon" onclick={() => rev++} title={t("Neu laden")} aria-label={t("Neu laden")}><Icon name="reload" size={15} /></button>
  </nav>

  <div class="main" class:wide={wide && hasDetail}>
    <div class="list" class:hidden={!wide && hasDetail && !!top}>
      {#if tab === "files"}
        <FilesTab {server} {ws} {rev} {title} {openKey} preview={wide} onOpen={open} />
      {:else if tab === "changes"}
        <ChangesTab {server} {ws} {rev} {openKey} preview={wide} onOpen={open} onStaged={staged} />
      {:else if tab === "history"}
        <HistoryTab {server} {ws} {rev} {openKey} preview={wide} wide={width >= 1100 || !wide} onOpen={open} onChanges={() => (tab = "changes")} />
      {:else}
        <BranchesTab {server} {ws} {rev} />
      {/if}
    </div>

    {#if hasDetail && (wide || top)}
      <div class="detail">
        {#if top}
          {#if stack.length > 1 || !wide}
            <div class="crumbbar">
              <button class="backbtn" onclick={back}><Icon name="back" size={14} /><span>{t("Zurück")}</span></button>
              {#if stack.length > 1}{@const prev = stack[stack.length - 2]}
                <span class="from">{prev.k === "commit" ? prev.subject : prev.k === "file" ? prev.path : prev.title}</span>
              {/if}
            </div>
          {/if}
          <div class="content">
            {#key openKey}
              {#if top.k === "file"}
                <FileViewer {server} {ws} path={top.path} {rev} />
              {:else if top.k === "diff"}
                <DiffPane {server} {ws} {rev} title={top.title} path={top.path} staged={top.staged} hash={top.hash} onStaged={staged} />
              {:else}
                <CommitView {server} {ws} hash={top.hash} subject={top.subject} onOpen={push} />
              {/if}
            {/key}
          </div>
        {:else}
          <div class="placeholder">
            <Icon name={tab === "files" ? "doc" : tab === "history" ? "commit" : "changes"} size={28} />
            <span>{tab === "files" ? t("Wähle eine Datei.") : tab === "history" ? t("Wähle einen Commit.") : t("Wähle eine Änderung.")}</span>
            <span class="keys">↑ ↓ · ⏎ · Esc</span>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .panel { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg); }
  .bar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border); }
  .seg { display: inline-flex; gap: 2px; padding: 3px; border-radius: 999px; background: var(--raised); border: 1px solid var(--border); }
  .seg button { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 999px;
    color: var(--muted); font-size: 13px; }
  .seg button:hover { color: var(--fg); }
  .seg button.on { background: color-mix(in srgb, var(--fg) 12%, transparent); color: var(--fg); }
  .icon { margin-left: auto; background: none; border: 1px solid transparent; border-radius: 8px; padding: 5px; color: var(--muted); display: inline-flex; }
  .icon:hover { border-color: var(--border); color: var(--fg); }
  .main { flex: 1; min-height: 0; display: flex; }
  .list { flex: 1; min-width: 0; overflow: auto; }
  .list.hidden { display: none; }
  .main.wide .list { flex: 0 0 clamp(300px, 36%, 460px); border-right: 1px solid var(--border); }
  .detail { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
  .content { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; }
  .content > :global(*) { flex: 1; }
  .crumbbar { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-bottom: 1px solid var(--border); font-size: 12.5px; }
  .backbtn { display: inline-flex; align-items: center; gap: 4px; background: none; border: 1px solid var(--border); border-radius: 7px;
    padding: 3px 9px 3px 6px; color: var(--muted); }
  .backbtn:hover { color: var(--fg); border-color: var(--accent); }
  .from { color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .placeholder { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--dim); }
  .keys { font-family: var(--mono); font-size: 11px; opacity: .7; }
  @media (max-width: 560px) { .seg button span { display: none; } }
</style>
