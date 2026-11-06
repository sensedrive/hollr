<script lang="ts">
  // Moshi-style repo browser for one space: files, changes, history graph, branches.
  // List and detail side by side (draggable splitter) or stacked (list on top, detail below);
  // "auto" stacks when narrow. The list can make way for the detail. Layout and tab remembered per place.
  import { untrack } from "svelte";
  import { t } from "../i18n";
  import { GIT_LAYOUT, clamp, gitKey, loadLayout, nextArrange, resolveArrange, saveLayout, type GitPlace } from "../layoutPrefs";
  import Splitter from "./Splitter.svelte";
  import BranchesTab from "./git/BranchesTab.svelte";
  import ChangesTab from "./git/ChangesTab.svelte";
  import CommitView from "./git/CommitView.svelte";
  import DiffPane from "./git/DiffPane.svelte";
  import FileViewer from "./git/FileViewer.svelte";
  import FilesTab from "./git/FilesTab.svelte";
  import HistoryTab from "./git/HistoryTab.svelte";
  import Icon from "./git/Icon.svelte";
  import { detailKey, type Detail, type Tab } from "./git/nav";

  /** `openFile`: a file (or folder) to show in the files tab – the file preview's "Im Git-Panel öffnen"; a new `n` opens it again */
  let { server, ws, title = "", place = "side", openFile }:
    { server: string; ws: string; title?: string; place?: GitPlace;
      openFile?: { path: string; dir: boolean; n: number } | null } = $props();

  // svelte-ignore state_referenced_locally
  const key = gitKey(place);
  let layout = $state(loadLayout(key, GIT_LAYOUT));
  const save = () => saveLayout(key, layout);
  /** the tab as last left in this place (all sessions' side panels share one) */
  let tab = $state<Tab>(untrack(() => layout.tab));
  $effect(() => {
    if (tab === untrack(() => layout.tab)) return;
    layout.tab = tab;
    save();
  });
  let rev = $state(0);
  let width = $state(0);
  let height = $state(0);
  let listWidth = $state(0);
  let details = $state<Record<Tab, Detail[]>>({ files: [], changes: [], history: [], branches: [] });

  const arrange = $derived(resolveArrange(layout.arrange, width));
  const wide = $derived(arrange === "side");
  const stack = $derived(details[tab]);
  const top = $derived(stack.at(-1));
  const openKey = $derived(detailKey(top));
  const hasDetail = $derived(tab !== "branches");
  /** side by side: the detail pane (or its placeholder) is always there; stacked: only while something is open */
  const showDetail = $derived(hasDetail && (wide || !!top));
  const listHidden = $derived(layout.listHidden && hasDetail && !!top);
  const showSplit = $derived(showDetail && !listHidden);

  const LIST_MIN_W = 220, DETAIL_MIN_W = 300, LIST_MIN_H = 110, DETAIL_MIN_H = 140;
  const maxW = $derived(Math.max(LIST_MIN_W, width - DETAIL_MIN_W));
  const maxH = $derived(Math.max(LIST_MIN_H, height - DETAIL_MIN_H));
  const listW = $derived(clamp(layout.listW, LIST_MIN_W, maxW));
  const listH = $derived(clamp(layout.listH, LIST_MIN_H, maxH));

  const arrangeLabel = $derived(
    layout.arrange === "auto"
      ? t("Anordnung: automatisch ({mode})", { mode: wide ? t("nebeneinander") : t("untereinander") })
      : layout.arrange === "side" ? t("Anordnung: nebeneinander") : t("Anordnung: untereinander"));
  function cycleArrange() {
    layout.arrange = nextArrange(layout.arrange);
    save();
  }
  function toggleList() {
    layout.listHidden = !layout.listHidden;
    save();
  }
  const mac = navigator.platform.toLowerCase().includes("mac");
  const listKeys = mac ? "⌥⌘\\" : "Ctrl+Alt+\\";

  // another space: start over
  let lastWs = "";
  $effect(() => {
    if (ws !== lastWs) { lastWs = ws; details = { files: [], changes: [], history: [], branches: [] }; }
  });
  let lastOpen = 0;
  /** the files tab goes to the opened file's folder */
  let folder = $state<{ path: string; n: number } | null>(null);
  $effect(() => {
    if (!openFile || openFile.n === lastOpen) return;
    lastOpen = openFile.n;
    tab = "files";
    folder = { path: openFile.dir ? openFile.path : openFile.path.split("/").slice(0, -1).join("/"), n: openFile.n };
    details.files = openFile.dir ? [] : [{ k: "file", path: openFile.path }];
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
    if ((e.metaKey || e.ctrlKey) && e.altKey && (e.code === "Backslash" || e.key === "\\")) {
      e.preventDefault();
      if (hasDetail && top) toggleList();
      return;
    }
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
    {#if hasDetail && top}
      <button class="icon" class:on={listHidden} onclick={toggleList}
        title={`${listHidden ? t("Liste einblenden") : t("Liste ausblenden – Detail über die ganze Fläche")} (${listKeys})`}
        aria-label={listHidden ? t("Liste einblenden") : t("Liste ausblenden")} aria-pressed={listHidden}>
        <Icon name={wide ? "panelLeft" : "panelTop"} size={15} /></button>
    {/if}
    <button class="icon" onclick={cycleArrange} title={`${arrangeLabel} – ${t("klicken zum Wechseln")}`} aria-label={arrangeLabel}>
      <Icon name={wide ? "split" : "unified"} size={15} />{#if layout.arrange === "auto"}<span class="auto">A</span>{/if}
    </button>
    <button class="icon" onclick={() => rev++} title={t("Neu laden")} aria-label={t("Neu laden")}><Icon name="reload" size={15} /></button>
  </nav>

  <div class="main" class:wide={wide && hasDetail} class:stacked={!wide && showDetail} bind:clientHeight={height}>
    <div class="list" class:hidden={listHidden} bind:clientWidth={listWidth}
      style:flex-basis={showSplit ? `${wide ? listW : listH}px` : null}>
      {#if tab === "files"}
        <FilesTab {server} {ws} {rev} {title} {openKey} {folder} preview={wide || !!top} onOpen={open} />
      {:else if tab === "changes"}
        <ChangesTab {server} {ws} {rev} {openKey} preview={wide || !!top} onOpen={open} onStaged={staged} />
      {:else if tab === "history"}
        <HistoryTab {server} {ws} {rev} {openKey} preview={wide || !!top} wide={listWidth >= 560} onOpen={open} onChanges={() => (tab = "changes")} />
      {:else}
        <BranchesTab {server} {ws} {rev} />
      {/if}
    </div>

    {#if showSplit}
      {#if wide}
        <Splitter size={listW} min={LIST_MIN_W} max={maxW} label={t("Liste breiter / schmaler")}
          onSize={(v) => (layout.listW = v)} onDone={save} onReset={() => { layout.listW = GIT_LAYOUT.listW; save(); }} />
      {:else}
        <Splitter axis="y" size={listH} min={LIST_MIN_H} max={maxH} label={t("Liste höher / niedriger")}
          onSize={(v) => (layout.listH = v)} onDone={save} onReset={() => { layout.listH = GIT_LAYOUT.listH; save(); }} />
      {/if}
    {/if}

    {#if showDetail}
      <div class="detail">
        {#if top}
          {#if stack.length > 1 || !wide}
            <div class="crumbbar">
              <button class="backbtn" onclick={back}><Icon name="back" size={14} /><span>{stack.length > 1 ? t("Zurück") : t("Schließen")}</span></button>
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
  .icon { background: none; border: 1px solid transparent; border-radius: 8px; padding: 5px; color: var(--muted); display: inline-flex; position: relative; }
  .icon:hover { border-color: var(--border); color: var(--fg); }
  .icon.on { color: var(--accent); }
  .bar > .icon:first-of-type { margin-left: auto; }
  .auto { position: absolute; right: 1px; bottom: 0; font: 700 8px/1 var(--mono); color: var(--accent); }
  .main { flex: 1; min-height: 0; display: flex; }
  .main.stacked { flex-direction: column; }
  .list { flex: 1; min-width: 0; min-height: 0; overflow: auto; }
  .list.hidden { display: none; }
  .main.wide .list, .main.stacked .list { flex-grow: 0; flex-shrink: 0; }
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
