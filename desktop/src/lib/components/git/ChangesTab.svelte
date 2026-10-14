<script lang="ts">
  // Uncommitted changes: branch + totals, staged / unstaged sections, stage/unstage per file, full-context diffs.
  import { onDestroy } from "svelte";
  import * as git from "../../git";
  import { t } from "../../i18n";
  import ChangeRow from "./ChangeRow.svelte";
  import Icon from "./Icon.svelte";
  import PlusMinus from "./PlusMinus.svelte";
  import Skeleton from "./Skeleton.svelte";
  import { detailKey, navKey, reveal, type Detail } from "./nav";

  let { server, ws, rev, openKey = "", preview = false, onOpen, onStaged }:
    { server: string; ws: string; rev: number; openKey?: string; preview?: boolean; onOpen: (d: Detail) => void;
      onStaged?: (path: string, staged: boolean) => void } = $props();

  let data = $state<git.Changes | null>(null);
  let error = $state("");
  let busy = $state<string | null>(null);
  let sel = $state(-1);
  let list: HTMLElement | undefined = $state();

  let seq = 0;
  async function load() {
    const n = ++seq;
    try {
      const r = await git.changes(server, ws);
      if (n === seq) { data = r; error = ""; }
    } catch (e) { if (n === seq) error = String(e); }
  }
  let lastWs = "";
  $effect(() => {
    void rev;
    if (ws !== lastWs) { data = null; lastWs = ws; }
    load();
  });

  type Item = { file: git.FileChange; staged: boolean };
  const items = $derived<Item[]>(data ? [...data.staged.map((file) => ({ file, staged: true })), ...data.unstaged.map((file) => ({ file, staged: false }))] : []);
  const all = $derived(data ? [...data.staged, ...data.unstaged] : []);
  const sections = $derived(data ? [
    { title: t("Gestaged"), staged: true, files: data.staged, offset: 0 },
    { title: t("Nicht gestaged"), staged: false, files: data.unstaged, offset: data.staged.length },
  ] : []);

  const detailOf = (it: Item): Detail => ({ k: "diff", title: it.file.path, path: it.file.path, staged: it.staged });

  async function toggle(it: Item) {
    busy = it.file.path;
    try {
      await git.stage(server, ws, it.file.path, !it.staged);
      onStaged?.(it.file.path, !it.staged);
      await load();
    } catch (e) { error = String(e); }
    busy = null;
  }

  function open(i: number) { const it = items[i]; if (it) { sel = i; onOpen(detailOf(it)); } }
  let timer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(timer));
  function select(i: number) {
    sel = i;
    reveal(list, i);
    if (preview) { clearTimeout(timer); timer = setTimeout(() => open(i), 140); }
  }
  function onkeydown(e: KeyboardEvent) {
    if (navKey(e, items.length, sel, select, open)) return;
    if ((e.key === " " || e.key === "s") && items[sel] && !e.metaKey && !e.ctrlKey) { e.preventDefault(); toggle(items[sel]); }
  }
  const summary = (d: git.Changes) => [
    d.unstaged.length ? t("{n} nicht gestaged", { n: d.unstaged.length }) : "",
    d.staged.length ? t("{n} gestaged", { n: d.staged.length }) : "",
  ].filter(Boolean).join(" · ");
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="tab" bind:this={list} tabindex="0" {onkeydown} role="listbox" aria-label={t("Änderungen")}>
  <div class="head">
    <h3>{t("Nicht committete Änderungen")}</h3>
    {#if data}
      <div class="sum">
        <span class="branch"><Icon name="branch" size={13} /><span>{data.branch}</span></span>
        <span class="dim small">{summary(data)}</span>
        <span class="sp"></span>
        <PlusMinus add={git.sumAdd(all)} del={git.sumDel(all)} />
      </div>
    {/if}
  </div>

  {#if error}<div class="state err">{error}</div>{/if}
  {#if !data && !error}
    <Skeleton kind="list" count={10} />
  {:else if data && !all.length}
    <div class="clean"><span class="ok"><Icon name="check" size={20} /></span><b>{t("Alles committet.")}</b>
      <span class="dim small">{t("Keine offenen Änderungen auf {branch}.", { branch: data.branch })}</span></div>
  {:else if data}
    {#each sections as s}
      {#if s.files.length}
        <div class="section"><span>{s.title}</span><span class="count">{s.files.length}</span></div>
        <div class="items">
          {#each s.files as file, j (file.path)}
            {@const it = { file, staged: s.staged }}
            {@const i = s.offset + j}
            <div class:kbd={i === sel}>
              <ChangeRow {file} index={i} selected={openKey === detailKey(detailOf(it))} onclick={() => open(i)}>
                {#snippet trailing()}
                  <button class="stage" class:busy={busy === file.path} disabled={busy === file.path} onclick={() => toggle(it)}
                    title={s.staged ? t("Unstagen") : t("Stagen")} aria-label={s.staged ? t("Unstagen") : t("Stagen")}>
                    <Icon name={s.staged ? "minus" : "plus"} size={13} />
                  </button>
                {/snippet}
              </ChangeRow>
            </div>
          {/each}
        </div>
      {/if}
    {/each}
    <div class="hint dim">{t("↑↓ wählen · ⏎ öffnen · Leertaste stagen")}</div>
  {/if}
</div>

<style>
  .tab { outline: none; }
  .head { padding: 12px 14px 6px; }
  h3 { margin: 0 0 6px; font-size: 15px; font-weight: 650; }
  .sum { display: flex; align-items: center; gap: 8px; }
  .branch { display: inline-flex; align-items: center; gap: 5px; font-family: var(--mono); font-size: 12px; padding: 2px 8px; border-radius: 99px;
    background: color-mix(in srgb, var(--purple) 15%, transparent); color: var(--purple); max-width: 50%; }
  .branch span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sp { flex: 1; }
  .small { font-size: 12px; }
  .section { display: flex; align-items: center; gap: 8px; margin: 14px 14px 4px; font-size: 11px; font-weight: 600; text-transform: uppercase;
    letter-spacing: .05em; color: var(--muted); }
  .count { font-family: var(--mono); color: var(--dim); }
  .items { padding: 0 6px; }
  .kbd { border-radius: 8px; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 60%, transparent); }
  .tab:not(:focus-within) .kbd { box-shadow: none; }
  .stage { width: 26px; height: 26px; flex: none; display: grid; place-items: center; border-radius: 7px; border: 1px solid var(--border);
    background: var(--card); color: var(--muted); padding: 0; }
  .stage:hover { color: var(--fg); border-color: var(--accent); }
  .stage.busy { animation: pulse 1s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .35; } }
  .clean { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 50px 20px; text-align: center; }
  .ok { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; color: var(--green);
    background: color-mix(in srgb, var(--green) 14%, transparent); margin-bottom: 4px; }
  .state { padding: 12px 16px; }
  .hint { font-size: 11px; padding: 16px 16px 12px; }
</style>
