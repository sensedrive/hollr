<script lang="ts">
  // Loads and shows a diff (working-tree file, staged file, whole commit or one file of a commit).
  import * as git from "../../git";
  import { t } from "../../i18n";
  import DiffView from "../DiffView.svelte";
  import Icon from "./Icon.svelte";
  import Skeleton from "./Skeleton.svelte";

  let { server, ws, title, path, staged, hash, rev = 0, onStaged }:
    { server: string; ws: string; title: string; path?: string; staged?: boolean; hash?: string; rev?: number;
      /** after stage/unstage from the toolbar: the file now lives on the other side */
      onStaged?: (path: string, staged: boolean) => void } = $props();

  let text = $state<string | null>(null);
  let error = $state("");
  let split = $state(git.pref("split", false));
  let wrap = $state(git.pref("wrap", false));
  let busy = $state(false);

  let seq = 0;
  $effect(() => {
    void rev;
    const n = ++seq;
    const src = { path, staged, hash };
    text = null; error = "";
    const p = src.hash ? git.commitDiff(server, ws, src.hash, src.path) : git.diff(server, ws, src.path ?? "", src.staged === true);
    p.then((r) => { if (n === seq) text = r; }, (e) => { if (n === seq) error = String(e); });
  });

  async function toggleStage() {
    if (!path || hash) return;
    busy = true;
    try {
      await git.stage(server, ws, path, !staged);
      onStaged?.(path, !staged);
    } catch (e) { error = String(e); }
    busy = false;
  }
</script>

<div class="pane">
  <header class="bar">
    <span class="title" title={path ?? title}><bdi>{title}</bdi></span>
    {#if !hash && path}
      <span class="pill" class:st={staged}>{staged ? t("Gestaged") : t("Nicht gestaged")}</span>
    {/if}
    <span class="tools">
      {#if !hash && path}
        <button class="tb" disabled={busy} onclick={toggleStage}>
          <Icon name={staged ? "minus" : "plus"} size={13} /><span>{staged ? t("Unstagen") : t("Stagen")}</span>
        </button>
      {/if}
      <span class="seg">
        <button class:on={!split} onclick={() => { split = false; git.setPref("split", false); }} title={t("Untereinander")}><Icon name="unified" size={14} /></button>
        <button class:on={split} onclick={() => { split = true; git.setPref("split", true); }} title={t("Nebeneinander")}><Icon name="split" size={14} /></button>
      </span>
      <button class="tb" class:on={wrap} disabled={split} onclick={() => { wrap = !wrap; git.setPref("wrap", wrap); }}
        title={wrap ? t("Nicht umbrechen") : t("Zeilen umbrechen")}><Icon name="wrap" size={14} /></button>
    </span>
  </header>
  <div class="body">
    {#if error}
      <div class="empty"><Icon name="x" size={22} /><b>{t("Fehler")}</b><span class="err">{error}</span></div>
    {:else if text === null}
      <div class="pad"><Skeleton kind="code" count={30} /></div>
    {:else}
      <DiffView {text} {split} {wrap} />
    {/if}
  </div>
</div>

<style>
  .pane { display: flex; flex-direction: column; min-height: 0; height: 100%; }
  .bar { display: flex; align-items: center; gap: 10px; padding: 8px 14px; border-bottom: 1px solid var(--border); min-height: 42px; }
  .title { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; font-size: 13px; font-weight: 600; }
  .pill.st { color: var(--green); background: color-mix(in srgb, var(--green) 14%, transparent); }
  .tools { margin-left: auto; display: flex; align-items: center; gap: 6px; }
  .tb { display: inline-flex; align-items: center; gap: 6px; background: none; border: 1px solid transparent; border-radius: 7px; padding: 4px 8px;
    color: var(--muted); font-size: 12px; white-space: nowrap; }
  .tb:hover:not(:disabled) { border-color: var(--border); color: var(--fg); }
  .tb.on { background: var(--card); border-color: var(--border); color: var(--fg); }
  .tb:disabled { opacity: .4; cursor: default; }
  .seg { display: inline-flex; background: var(--raised); border: 1px solid var(--border); border-radius: 8px; padding: 2px; }
  .seg button { background: none; border: 0; border-radius: 6px; padding: 3px 7px; color: var(--muted); display: inline-flex; }
  .seg button.on { background: var(--card); color: var(--fg); box-shadow: 0 0 0 1px var(--border); }
  .body { flex: 1; overflow: auto; min-height: 0; }
  .pad { padding: 12px 14px; }
  .empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 60px 20px; color: var(--muted); text-align: center; }
  .empty b { color: var(--fg); font-size: 15px; }
</style>
