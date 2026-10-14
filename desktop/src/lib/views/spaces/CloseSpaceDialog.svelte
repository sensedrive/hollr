<script lang="ts">
  // Close a space with all options: keep files, remove the worktree (with or without its branch,
  // locally and on origin) or delete a plain folder – showing first what would be lost.
  // "Änderungen ansehen" opens the git panel right next to the options.
  import GitPanel from "$lib/components/GitPanel.svelte";
  import { t } from "$lib/i18n";
  import { refresh, refreshSpaces } from "$lib/store.svelte";
  import { closeInfo, space as spaceOp, type CloseInfo, type FullSpace, type SpaceRequest } from "./spaces";

  let { server, space, onClose, onClosed }: {
    server: string; space: FullSpace; onClose: () => void; onClosed?: () => void;
  } = $props();

  type Option = "close" | "removeWorktree" | "removeWorktreeAndBranch" | "deleteFolder";
  let info = $state<CloseInfo | null>(null);
  let infoError = $state("");
  let option = $state<Option>("close");
  let deleteRemote = $state(false);
  let discard = $state(false);
  let confirmText = $state("");
  let busy = $state(false);
  let error = $state("");
  let showGit = $state(false);

  $effect(() => {
    closeInfo(server, space.id).then((i) => (info = i)).catch((e) => (infoError = e instanceof Error ? e.message : String(e)));
  });

  const destructive = $derived(option !== "close");
  const canRun = $derived(!!info && !busy && (!destructive || confirmText === space.label));
  const choices = $derived.by(() => {
    const out: { value: Option; title: string; detail: string }[] = [
      { value: "close", title: t("Nur schließen"), detail: t("Sitzungen beenden, Dateien und Branch bleiben.") },
    ];
    if (info?.isWorktree) {
      out.push({ value: "removeWorktree", title: t("Worktree entfernen"), detail: t("Ordner wird gelöscht, der Branch bleibt.") });
      if (info.branch && !info.defaultBranch)
        out.push({ value: "removeWorktreeAndBranch", title: t("Worktree und Branch löschen"),
          detail: t("Ordner und Branch „{branch}“ werden gelöscht.", { branch: info.branch }) });
    }
    if (info?.canDeleteFolder)
      out.push({ value: "deleteFolder", title: t("Ordner komplett löschen"), detail: t("Alles in {root} wird endgültig gelöscht.", { root: info.root }) });
    return out;
  });

  async function run() {
    if (!canRun) return;
    busy = true; error = "";
    const body: SpaceRequest = { op: "close", ws: space.id };
    if (option === "removeWorktree") body.removeWorktree = true;
    else if (option === "removeWorktreeAndBranch") Object.assign(body, { removeWorktree: true, deleteBranch: true, deleteRemote });
    else if (option === "deleteFolder") body.deleteFolder = true;
    if (discard) body.force = true;
    try {
      await spaceOp(server, body);
      await Promise.all([refreshSpaces(server), refresh()]);
      onClosed?.();
      onClose();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    busy = false;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); if (showGit) showGit = false; else onClose(); }
    else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); }
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && onClose()}>
  <div class="sheet" class:wide={showGit} role="dialog" aria-label={t("„{name}“ schließen", { name: space.label })}>
    <div class="opts">
      <h2>{t("„{name}“ schließen", { name: space.label })}</h2>

      <div class="card facts">
        <div class="fact"><span class="muted">{t("Ordner")}</span><span class="mono small val">{info?.root ?? space.root}</span></div>
        {#if info?.branch}<div class="fact"><span class="muted">{t("Branch")}</span><span class="mono small val">{info.branch}</span></div>{/if}
        {#if info}
          {#if info.changed > 0}
            <button class="fact link warn" onclick={() => (showGit = true)}>
              <span>⚠ {t("{n} ungespeicherte Änderung(en)", { n: info.changed })}</span>
              <span class="mono small"><span style="color:var(--green)">+{info.add}</span> <span style="color:var(--red)">−{info.del}</span></span>
            </button>
          {/if}
          {#if info.unpushed > 0}
            <button class="fact link warn" onclick={() => (showGit = true)}>↑ {t("{n} Commit(s) nicht gepusht", { n: info.unpushed })}</button>
          {/if}
          {#if info.agents > 0}<div class="fact muted">〰 {t("{n} Sitzung(en) werden beendet", { n: info.agents })}</div>{/if}
          {#if info.git}
            <button class="fact link" onclick={() => (showGit = !showGit)}>⑂ {showGit ? t("Git-Ansicht schließen") : t("Änderungen, Verlauf und Branches ansehen")}</button>
          {/if}
        {:else if infoError}
          <div class="err small">{infoError}</div>
        {:else}
          <div class="skeleton" style="height:12px; width:60%"></div>
          <div class="skeleton" style="height:12px; width:40%"></div>
        {/if}
      </div>

      <div class="section">{t("Was soll passieren?")}</div>
      <div class="rows" role="radiogroup">
        {#each choices as c}
          <button class="choice" role="radio" aria-checked={option === c.value} class:on={option === c.value}
            class:danger={c.value !== "close"} onclick={() => (option = c.value)}>
            <span class="radio"></span>
            <span class="grow"><span>{c.title}</span><span class="small muted detail">{c.detail}</span></span>
          </button>
        {/each}
      </div>
      {#if info && !info.isWorktree && !info.canDeleteFolder && (info.linkedWorktrees ?? 0) > 0}
        <div class="small muted">{t("Ordner löschen ist gesperrt: {n} Worktree(s) hängen an diesem Repo.", { n: info.linkedWorktrees ?? 0 })}</div>
      {/if}

      {#if option === "removeWorktreeAndBranch" && info?.remoteBranch}
        <label class="tog"><input type="checkbox" class="toggle" bind:checked={deleteRemote} />
          <span class="grow">{t("Auch auf origin löschen")}<span class="small muted detail">{t("Löscht den Branch zusätzlich im entfernten Repository (z. B. GitHub).")}</span></span></label>
      {/if}
      {#if (option === "removeWorktree" || option === "removeWorktreeAndBranch") && (info?.changed ?? 0) > 0}
        <label class="tog"><input type="checkbox" class="toggle" bind:checked={discard} />
          <span class="grow">{t("Ungespeicherte Änderungen verwerfen")}<span class="small muted detail">{t("Ohne diesen Haken bricht das Entfernen ab, solange Änderungen offen sind.")}</span></span></label>
      {/if}
      {#if destructive}
        <label class="confirm">
          <span class="small muted">{t("Zur Bestätigung „{name}“ eingeben", { name: space.label })}</span>
          <!-- svelte-ignore a11y_autofocus -->
          <input placeholder={space.label} bind:value={confirmText} autocomplete="off" spellcheck="false" autofocus
            onkeydown={(e) => e.key === "Enter" && run()} />
        </label>
      {/if}
      {#if error}<div class="err">{error}</div>{/if}

      <div class="buttons">
        <button class="btn" onclick={onClose}>{t("Abbrechen")}</button>
        <button class="btn solid-danger" disabled={!canRun} onclick={run}>{busy ? "…" : destructive ? t("Löschen") : t("Schließen")}</button>
      </div>
    </div>
    {#if showGit}
      <div class="git"><GitPanel {server} ws={space.id} /></div>
    {/if}
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, .5); display: grid; place-items: center; z-index: 10; }
  .sheet { background: var(--side); border: 1px solid var(--border); border-radius: 14px; width: min(560px, 92vw); max-height: 88vh;
    display: grid; grid-template-columns: 1fr; overflow: hidden; }
  .sheet.wide { width: min(1180px, 95vw); height: 88vh; grid-template-columns: 460px 1fr; }
  .opts { padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; min-height: 0; }
  .git { border-left: 1px solid var(--border); min-height: 0; min-width: 0; overflow: hidden; }
  h2 { margin: 0; font-size: 17px; }
  .facts { display: grid; gap: 8px; }
  .fact { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .val { text-align: right; word-break: break-all; }
  .link { all: unset; cursor: pointer; display: flex; justify-content: space-between; gap: 12px; color: var(--accent); }
  .link:hover, .link:focus-visible { text-decoration: underline; }
  .warn { color: var(--orange); }
  .section { margin: 6px 0 -4px; }
  .choice { all: unset; box-sizing: border-box; cursor: pointer; display: flex; align-items: center; gap: 12px; padding: 10px 14px; width: 100%; }
  .choice:hover, .choice:focus-visible { background: color-mix(in srgb, var(--fg) 5%, transparent); }
  .choice .grow { display: grid; }
  .radio { width: 16px; height: 16px; border-radius: 50%; border: 1.5px solid var(--accent); flex: none; box-sizing: border-box; }
  .danger .radio { border-color: var(--red); }
  .on .radio { border-width: 5px; }
  .detail { display: block; }
  .tog { display: flex; align-items: center; gap: 12px; cursor: pointer; }
  .confirm { display: grid; gap: 6px; }
  .buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
  .solid-danger { background: var(--red); border-color: var(--red); color: #fff; }
</style>
