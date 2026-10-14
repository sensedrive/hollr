<script lang="ts">
  // History graph: uncommitted-changes row on top, lanes with colors, ref chips, search; commits open in the detail pane.
  import { onDestroy } from "svelte";
  import * as git from "../../git";
  import { t } from "../../i18n";
  import GraphCell from "./GraphCell.svelte";
  import Icon from "./Icon.svelte";
  import PlusMinus from "./PlusMinus.svelte";
  import Skeleton from "./Skeleton.svelte";
  import { navKey, reveal, type Detail } from "./nav";

  let { server, ws, rev, openKey = "", preview = false, wide = false, onOpen, onChanges }:
    { server: string; ws: string; rev: number; openKey?: string; preview?: boolean; wide?: boolean;
      onOpen: (d: Detail) => void; onChanges: () => void } = $props();

  const H = 34;
  const MAX_LANES = 12;

  let data = $state<git.Graph | null>(null);
  let error = $state("");
  let filter = $state("");
  let sel = $state(-1);
  let list: HTMLElement | undefined = $state();

  let seq = 0;
  async function load() {
    const n = ++seq;
    try {
      const r = await git.graph(server, ws, 200);
      if (n === seq) { data = r; error = ""; }
    } catch (e) { if (n === seq) error = String(e); }
  }
  let lastWs = "";
  $effect(() => {
    void rev;
    if (ws !== lastWs) { data = null; lastWs = ws; }
    load();
  });

  const dirty = $derived((data?.changes.files ?? 0) > 0);
  const rows = $derived(data ? git.graphRows(data.commits, dirty) : []);
  const laneWidth = $derived(Math.min(MAX_LANES, Math.max(1, ...rows.map((r) => r.width))));
  const q = $derived(filter.trim().toLowerCase());
  const shown = $derived(!q ? rows : rows.filter((r) =>
    r.commit.subject.toLowerCase().includes(q) || r.commit.author.toLowerCase().includes(q) ||
    r.commit.hash.startsWith(q) || (r.commit.refs ?? "").toLowerCase().includes(q)));

  const detailOf = (c: git.GraphCommit): Detail => ({ k: "commit", hash: c.hash, subject: c.subject });
  function open(i: number) { const r = shown[i]; if (r) { sel = i; onOpen(detailOf(r.commit)); } }
  let timer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(timer));
  function select(i: number) {
    sel = i;
    reveal(list, i);
    if (preview) { clearTimeout(timer); timer = setTimeout(() => open(i), 160); }
  }
  function onkeydown(e: KeyboardEvent) {
    if (navKey(e, shown.length, sel, select, open)) return;
    if (e.key === "Escape" && filter) { filter = ""; e.preventDefault(); }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="tab" bind:this={list} tabindex="0" {onkeydown} role="listbox" aria-label={t("Verlauf")}>
  <div class="head">
    <h3>{t("Verlauf")}</h3>
    <label class="filter">
      <Icon name="search" size={13} />
      <input bind:value={filter} placeholder={t("Commits durchsuchen …")} spellcheck="false" oninput={() => (sel = -1)} />
    </label>
  </div>

  {#if error}<div class="state err">{error}</div>{/if}
  {#if !data && !error}
    <Skeleton kind="graph" count={16} />
  {:else if data}
    {#if dirty && !q}
      <button class="row wip" onclick={onChanges}>
        <svg width={11 + laneWidth * 14 - 3} height={H} class="g" aria-hidden="true">
          <line x1="11" y1={H / 2 + 6} x2="11" y2={H} stroke={git.laneColor(0)} stroke-width="2" />
          <circle cx="11" cy={H / 2} r="5.5" fill="none" stroke={git.laneColor(0)} stroke-width="2" stroke-dasharray="3 2.2" />
        </svg>
        <span class="subject wipt">{t("Nicht committete Änderungen")}</span>
        <span class="pill">{t("{n} Dateien", { n: data.changes.files })}</span>
        <PlusMinus add={data.changes.add} del={data.changes.del} />
      </button>
    {/if}
    {#if !shown.length}
      <div class="state dim">{q ? t("Keine Treffer") : t("Noch keine Commits.")}</div>
    {/if}
    {#each shown as r, i (r.commit.hash)}
      {@const open_ = openKey === `commit:${r.commit.hash}`}
      <button class="row" data-i={i} class:sel={i === sel} class:open={open_} onclick={() => open(i)} title={r.commit.subject}>
        {#if q}
          <span class="qdot" style="background:{git.laneColor(r.node)}"></span>
        {:else}
          <GraphCell row={r} width={laneWidth} height={H} selected={open_} />
        {/if}
        {#each git.parseRefs(r.commit.refs) as ref}
          <span class="ref {ref.kind}">{#if ref.kind === "tag"}<Icon name="tag" size={10} />{/if}{ref.name}</span>
        {/each}
        <span class="subject" class:merge={r.commit.parents.length > 1}>{r.commit.subject}</span>
        {#if wide}<span class="author">{r.commit.author}</span>{/if}
        <span class="hash">{r.commit.hash.slice(0, 7)}</span>
        <span class="age">{git.age(r.commit.at)}</span>
      </button>
    {/each}
    {#if data.commits.length >= 200 && !q}<div class="state dim small">{t("Die letzten 200 Commits.")}</div>{/if}
  {/if}
</div>

<style>
  .tab { outline: none; padding-bottom: 16px; }
  .head { position: sticky; top: 0; z-index: 2; background: var(--bg); padding: 12px 14px 8px; display: flex; align-items: center; gap: 12px; }
  h3 { margin: 0; font-size: 15px; font-weight: 650; flex: none; }
  .filter { flex: 1; max-width: 320px; margin-left: auto; display: flex; align-items: center; gap: 6px; color: var(--dim); background: var(--raised);
    border: 1px solid var(--border); border-radius: 8px; padding: 0 8px; }
  .filter:focus-within { border-color: var(--accent); }
  .filter input { all: unset; flex: 1; padding: 5px 0; font-size: 12.5px; color: var(--fg); min-width: 0; }
  .row { all: unset; box-sizing: border-box; cursor: pointer; display: flex; align-items: center; gap: 8px; width: 100%; height: 34px;
    padding: 0 12px 0 6px; }
  .row:hover { background: color-mix(in srgb, var(--fg) 5%, transparent); }
  .row.open { background: color-mix(in srgb, var(--fg) 8%, transparent); }
  .row.sel { background: color-mix(in srgb, var(--accent) 16%, transparent); }
  .tab:not(:focus-within) .row.sel:not(.open) { background: transparent; }
  .g { flex: none; display: block; }
  .qdot { width: 9px; height: 9px; border-radius: 50%; margin: 0 6px; flex: none; }
  .subject { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .subject.merge { color: var(--muted); }
  .wipt { font-weight: 600; }
  .author { color: var(--muted); font-size: 12px; max-width: 130px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: none; }
  .hash { font-family: var(--mono); font-size: 11.5px; color: var(--dim); flex: none; }
  .age { font-size: 11.5px; color: var(--dim); width: 30px; text-align: right; flex: none; font-variant-numeric: tabular-nums; }
  .ref { flex: none; display: inline-flex; align-items: center; gap: 3px; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font: 600 10.5px/1 var(--mono); padding: 3px 6px; border-radius: 5px; border: 1px solid; }
  .ref.head { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 55%, transparent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
  .ref.local { color: var(--purple); border-color: color-mix(in srgb, var(--purple) 45%, transparent); }
  .ref.remote { color: var(--muted); border-color: var(--border); }
  .ref.tag { color: var(--yellow); border-color: color-mix(in srgb, var(--yellow) 45%, transparent); }
  .state { padding: 12px 16px; }
  .small { font-size: 11.5px; }
</style>
