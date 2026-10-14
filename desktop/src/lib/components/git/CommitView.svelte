<script lang="ts">
  // Commit detail (CommitSheet on iOS): message, changed files with +/-, hash/author/date, open the whole or per-file diff.
  import * as git from "../../git";
  import { t } from "../../i18n";
  import ChangeRow from "./ChangeRow.svelte";
  import Icon from "./Icon.svelte";
  import PlusMinus from "./PlusMinus.svelte";
  import Skeleton from "./Skeleton.svelte";
  import { navKey, reveal, type Detail } from "./nav";

  let { server, ws, hash, subject, onOpen }:
    { server: string; ws: string; hash: string; subject: string; onOpen: (d: Detail) => void } = $props();

  let detail = $state<git.CommitDetail | null>(null);
  let error = $state("");
  let copied = $state(false);
  let showAll = $state(false);
  let sel = $state(-1);
  let root: HTMLElement | undefined = $state();

  let seq = 0;
  $effect(() => {
    const h = hash;
    const n = ++seq;
    detail = null; error = ""; showAll = false; sel = -1;
    git.commit(server, ws, h).then((d) => { if (n === seq) detail = d; }, (e) => { if (n === seq) error = String(e); });
  });

  const files = $derived(detail ? (showAll ? detail.files : detail.files.slice(0, 60)) : []);
  const short = $derived(hash.slice(0, 8));

  function openFile(i: number) {
    const f = files[i];
    if (f) { sel = i; onOpen({ k: "diff", title: f.path, hash, path: f.path }); }
  }
  const openAll = () => onOpen({ k: "diff", title: `${short} · ${subject}`, hash });
  async function copy() {
    try { await navigator.clipboard.writeText(detail?.hash ?? hash); copied = true; setTimeout(() => (copied = false), 1500); } catch {}
  }
  function onkeydown(e: KeyboardEvent) {
    navKey(e, files.length, sel, (i) => { sel = i; reveal(root, i); }, openFile);
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="commit" bind:this={root} tabindex="0" {onkeydown} role="listbox" aria-label={t("Geänderte Dateien")}>
  <h2>{detail?.subject ?? subject}</h2>
  {#if detail?.body}<p class="body">{detail.body}</p>{/if}

  <div class="actions">
    <button class="btn primary" onclick={openAll}><Icon name="changes" size={14} />{t("Änderungen anzeigen")}</button>
    <button class="btn" onclick={copy} title={t("Commit-Hash kopieren")}>
      <Icon name={copied ? "check" : "copy"} size={14} /><span class="mono">{copied ? t("Kopiert") : short}</span>
    </button>
  </div>

  {#if error}
    <div class="err">{error}</div>
  {:else if !detail}
    <Skeleton kind="list" count={5} />
  {:else}
    <div class="fhead">
      <span>{t("Geänderte Dateien")}</span><span class="count">{detail.files.length}</span>
      <span class="sp"></span>
      <PlusMinus add={git.sumAdd(detail.files)} del={git.sumDel(detail.files)} />
    </div>
    {#if detail.merge}<div class="note">{t("Merge – zeigt, was der Merge gebracht hat.")}</div>{/if}
    <div class="files">
      {#each files as f, i (f.path)}
        <div class:kbd={i === sel}><ChangeRow file={f} index={i} onclick={() => openFile(i)} /></div>
      {/each}
      {#if !detail.files.length}<div class="dim pad">{t("Keine Änderungen")}</div>{/if}
    </div>
    {#if detail.files.length > files.length}
      <button class="more" onclick={() => (showAll = true)}>{t("Alle {n} Dateien anzeigen", { n: detail.files.length })}</button>
    {/if}

    <dl class="info">
      <div><dt>{t("Commit")}</dt><dd class="mono sel">{detail.hash}</dd></div>
      <div><dt>{t("Autor")}</dt><dd>{detail.author} <span class="muted">&lt;{detail.email}&gt;</span></dd></div>
      <div><dt>{t("Datum")}</dt><dd>{git.dateTime(detail.at)} · <span class="muted">{git.relative(detail.at)}</span></dd></div>
    </dl>
  {/if}
</div>

<style>
  .commit { outline: none; padding: 20px 22px 32px; max-width: 900px; }
  h2 { margin: 0 0 8px; font-size: 18px; font-weight: 650; line-height: 1.35; user-select: text; }
  .body { margin: 0 0 12px; color: var(--muted); white-space: pre-wrap; font-size: 13px; user-select: text; }
  .actions { display: flex; gap: 8px; margin: 14px 0 20px; flex-wrap: wrap; }
  .actions .btn { display: inline-flex; align-items: center; gap: 7px; border-radius: 99px; padding: 6px 14px; }
  .fhead { display: flex; align-items: center; gap: 8px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em;
    color: var(--muted); margin-bottom: 6px; }
  .count { font-family: var(--mono); color: var(--dim); }
  .sp { flex: 1; }
  .note { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
  .files { margin: 0 -6px; }
  .kbd { border-radius: 8px; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 60%, transparent); }
  .commit:not(:focus-within) .kbd { box-shadow: none; }
  .more { all: unset; cursor: pointer; color: var(--accent); font-size: 12.5px; margin: 6px 2px; }
  .info { margin: 22px 0 0; padding: 14px 16px; border-radius: 12px; background: color-mix(in srgb, var(--fg) 5%, transparent);
    display: flex; flex-direction: column; gap: 12px; }
  dt { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  dd { margin: 2px 0 0; font-size: 13px; word-break: break-all; }
  .sel { user-select: all; }
  .pad { padding: 10px 8px; }
</style>
