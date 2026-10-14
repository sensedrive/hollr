<script lang="ts">
  // Repo browser: breadcrumbs, folders first, file-type badges, age; files open in the detail pane.
  import { onDestroy } from "svelte";
  import * as git from "../../git";
  import { t } from "../../i18n";
  import FileGlyph from "./FileGlyph.svelte";
  import Icon from "./Icon.svelte";
  import Skeleton from "./Skeleton.svelte";
  import { navKey, reveal, type Detail } from "./nav";

  let { server, ws, rev, title = "", openKey = "", preview = false, onOpen }:
    { server: string; ws: string; rev: number; title?: string; openKey?: string; preview?: boolean; onOpen: (d: Detail) => void } = $props();

  let path = $state("");
  let entries = $state<git.DirEntry[] | null>(null);
  let error = $state("");
  let filter = $state("");
  let sel = $state(-1);
  let list: HTMLElement | undefined = $state();

  const shown = $derived((entries ?? []).filter((e) => !filter || e.name.toLowerCase().includes(filter.toLowerCase())));
  const crumbs = $derived(path ? path.split("/") : []);

  let seq = 0;
  async function load() {
    const n = ++seq;
    const p = path;
    error = "";
    try {
      const r = await git.ls(server, ws, p);
      if (n === seq) entries = r;
    } catch (e) { if (n === seq) { error = String(e); entries = []; } }
  }
  $effect(() => { void rev; void ws; void path; entries = null; load(); });

  function goTo(p: string) {
    if (p === path) return;
    const from = path;
    path = p;
    filter = "";
    // coming back up: keep the folder we came from selected
    sel = -1;
    if (from.startsWith(p ? p + "/" : "")) pendingSelect = from.slice(p ? p.length + 1 : 0).split("/")[0];
    list?.focus();
  }
  let pendingSelect = "";
  $effect(() => {
    if (!entries || !pendingSelect) return;
    const i = shown.findIndex((e) => e.name === pendingSelect);
    pendingSelect = "";
    if (i !== -1) { sel = i; queueMicrotask(() => reveal(list, i)); }
  });

  function open(i: number) {
    const e = shown[i];
    if (!e) return;
    sel = i;
    const full = git.joinPath(path, e.name);
    if (e.dir) goTo(full);
    else onOpen({ k: "file", path: full });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(timer));
  function select(i: number) {
    sel = i;
    reveal(list, i);
    const e = shown[i];
    if (preview && e && !e.dir) {
      clearTimeout(timer);
      timer = setTimeout(() => onOpen({ k: "file", path: git.joinPath(path, e.name) }), 140);
    }
  }

  function onkeydown(e: KeyboardEvent) {
    if (navKey(e, shown.length, sel, select, open)) return;
    const typing = (e.target as HTMLElement).tagName === "INPUT";
    if ((e.key === "Backspace" && !typing) || (e.key === "ArrowLeft" && !typing)) {
      if (path) { e.preventDefault(); goTo(git.dirName(path)); }
    } else if (e.key === "Escape" && filter) { filter = ""; e.preventDefault(); }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="tab" bind:this={list} tabindex="0" {onkeydown} role="listbox" aria-label={t("Dateien")}>
  <div class="head">
    <nav class="crumbs">
      <button class="crumb root" class:last={!crumbs.length} onclick={() => goTo("")}>
        <Icon name="files" size={15} /><span>{title || "/"}</span>
      </button>
      {#each crumbs as c, i}
        <span class="sep"><Icon name="chevronR" size={11} /></span>
        <button class="crumb" class:last={i === crumbs.length - 1} onclick={() => goTo(crumbs.slice(0, i + 1).join("/"))}>{c}</button>
      {/each}
    </nav>
    <label class="filter">
      <Icon name="search" size={13} />
      <input bind:value={filter} placeholder={t("Filtern …")} spellcheck="false" oninput={() => (sel = shown.length ? 0 : -1)} />
    </label>
  </div>

  {#if error}<div class="state err">{error}</div>{/if}
  {#if entries === null}
    <Skeleton kind="list" count={14} />
  {:else if !shown.length && !error}
    <div class="state dim">{filter ? t("Keine Treffer") : t("Leerer Ordner")}</div>
  {:else}
    <div class="items">
      {#if path}
        <button class="item up" onclick={() => goTo(git.dirName(path))}>
          <span class="upi"><Icon name="back" size={14} /></span><span class="name dim">..</span>
        </button>
      {/if}
      {#each shown as e, i (e.name)}
        {@const full = git.joinPath(path, e.name)}
        <button class="item" data-i={i} class:sel={i === sel} class:open={openKey === `file:${full}`}
          onclick={() => { sel = i; open(i); }} title={full}>
          <FileGlyph name={e.name} dir={e.dir} />
          <span class="name" class:hidden={e.name.startsWith(".")}>{e.name}</span>
          {#if !e.dir && e.size}<span class="meta size">{git.bytes(e.size)}</span>{/if}
          <span class="meta">{e.mtime ? git.age(e.mtime) : ""}</span>
          {#if e.dir}<span class="chev"><Icon name="chevronR" size={12} /></span>{/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .tab { outline: none; display: flex; flex-direction: column; min-height: 0; }
  .head { position: sticky; top: 0; z-index: 2; background: var(--bg); padding: 10px 12px 8px; display: flex; flex-direction: column; gap: 8px; }
  .crumbs { display: flex; align-items: center; flex-wrap: wrap; gap: 2px; min-width: 0; font-size: 13px; }
  .crumb { all: unset; cursor: pointer; padding: 2px 6px; border-radius: 6px; color: var(--muted); display: inline-flex; align-items: center; gap: 6px;
    max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .crumb:hover { background: color-mix(in srgb, var(--fg) 7%, transparent); color: var(--fg); }
  .crumb.last { color: var(--fg); font-weight: 600; }
  .crumb.root span { overflow: hidden; text-overflow: ellipsis; }
  .sep { color: var(--dim); display: inline-flex; }
  .filter { display: flex; align-items: center; gap: 6px; color: var(--dim); background: var(--raised); border: 1px solid var(--border);
    border-radius: 8px; padding: 0 8px; }
  .filter:focus-within { border-color: var(--accent); }
  .filter input { all: unset; flex: 1; padding: 5px 0; font-size: 12.5px; color: var(--fg); }
  .items { padding: 0 6px 12px; }
  .item { all: unset; box-sizing: border-box; cursor: pointer; width: 100%; display: flex; align-items: center; gap: 10px;
    padding: 5px 8px; min-height: 32px; border-radius: 8px; }
  .item:hover { background: color-mix(in srgb, var(--fg) 5%, transparent); }
  .item.open { background: color-mix(in srgb, var(--fg) 8%, transparent); }
  .item.sel { background: color-mix(in srgb, var(--accent) 16%, transparent); }
  .tab:not(:focus-within) .item.sel:not(.open) { background: transparent; }
  .name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .name.hidden { color: var(--muted); }
  .meta { font-size: 11.5px; color: var(--dim); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .size { min-width: 52px; text-align: right; }
  .chev { color: var(--dim); display: inline-flex; }
  .upi { width: 22px; display: inline-grid; place-items: center; color: var(--dim); }
  .state { padding: 18px 16px; }
</style>
