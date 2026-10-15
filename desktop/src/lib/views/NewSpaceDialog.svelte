<script lang="ts">
  // Create a herdr space: a git worktree (new branch) of a repo space, or a folder.
  import Modal from "$lib/components/Modal.svelte";
  import { t } from "$lib/i18n";
  import { app, dialogMemory, go, refresh, refreshSpaces } from "$lib/store.svelte";
  import { space as spaceOp, type FullSpace } from "./spaces/spaces";

  let { preset, onClose }: { preset: { server?: string; repo?: string }; onClose: () => void } = $props();

  // svelte-ignore state_referenced_locally
  let server = $state(preset.server ?? app.servers[0]?.id ?? "");
  let kind = $state<"worktree" | "folder">("worktree");
  // svelte-ignore state_referenced_locally
  let repo = $state(preset.repo ?? "");
  // typed fields survive closing the dialog by accident
  const memory = dialogMemory.newSpace;
  let branch = $state(memory.branch);
  let base = $state(memory.base);
  let folder = $state(memory.folder);
  let label = $state(memory.label);
  $effect(() => {
    Object.assign(memory, { branch, base, folder, label });
  });
  let agent = $state("omp");
  let busy = $state(false);
  let error = $state("");

  const loaded = $derived(app.spaces[server] !== undefined);
  const repos = $derived(((app.spaces[server] ?? []) as FullSpace[]).filter((s) => !s.isWorktree && s.git));

  // load spaces if needed; default to the first repo, or to "folder" when there is none
  $effect(() => {
    if (server && !loaded) refreshSpaces(server);
  });
  $effect(() => {
    if (!loaded) return;
    if (!repos.some((r) => r.id === repo)) repo = repos[0]?.id ?? "";
    if (!repos.length) kind = "folder";
  });

  const valid = $derived(kind === "folder" ? !!folder.trim() : !!repo && !!branch.trim());

  async function create() {
    if (!valid || busy) return;
    busy = true; error = "";
    try {
      const r = await spaceOp(server, kind === "worktree"
        ? { op: "worktree", ws: repo, branch: branch.trim(), ...(base.trim() ? { base: base.trim() } : {}), label, agent }
        : { op: "create", cwd: folder.trim(), label, agent });
      Object.assign(memory, { branch: "", base: "", folder: "~/projects/", label: "" });
      await Promise.all([refreshSpaces(server), refresh()]);
      onClose();
      if (r.pane && agent) go({ view: "agent", server, pane: r.pane });
      else if (r.ws) go({ view: "space", server, ws: r.ws });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    busy = false;
  }

  const mod = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl+";

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); create(); }
  }
</script>

<svelte:window onkeydown={onKey} />

<Modal title={t("Neuer Space")} {onClose}>
  <div class="seg" role="radiogroup" aria-label={t("Art")}>
    <button role="radio" aria-checked={kind === "worktree"} class:on={kind === "worktree"} disabled={loaded && !repos.length}
      onclick={() => (kind = "worktree")}>⑂ {t("Worktree")}</button>
    <button role="radio" aria-checked={kind === "folder"} class:on={kind === "folder"} onclick={() => (kind = "folder")}>▢ {t("Ordner")}</button>
  </div>

  {#if app.servers.length > 1}
    <label class="field"><span>{t("Server")}</span>
      <select bind:value={server}>{#each app.servers as s}<option value={s.id}>{s.label}</option>{/each}</select></label>
  {/if}

  {#if kind === "worktree"}
    <div class="section">{t("Git-Worktree")}</div>
    <label class="field"><span>{t("Repo")}</span>
      {#if !loaded}<div class="skeleton" style="height:34px"></div>
      {:else}
        <select bind:value={repo}>{#each repos as r}<option value={r.id}>{r.label} ({r.git?.branch ?? "?"})</option>{/each}</select>
      {/if}
    </label>
    <!-- svelte-ignore a11y_autofocus -->
    <input class="mono" placeholder={t("Neuer Branch, z. B. feature/PROJ-123-login")} bind:value={branch} autofocus
      autocomplete="off" spellcheck="false" onkeydown={(e) => e.key === "Enter" && create()} />
    <input class="mono" placeholder={t("Basis (leer = aktueller Branch)")} bind:value={base} autocomplete="off" spellcheck="false" />
    <div class="small muted">{t("herdr legt einen eigenen Arbeitsordner mit neuem Branch an – parallel zu main, ohne dass sich Agents in die Quere kommen.")}</div>
  {:else}
    <div class="section">{t("Ordner")}</div>
    <input class="mono" placeholder={t("Ordner auf dem Server")} bind:value={folder} autocomplete="off" spellcheck="false"
      onkeydown={(e) => e.key === "Enter" && create()} />
    <div class="small muted">{t("Wird angelegt, falls er noch nicht existiert.")}</div>
  {/if}

  <div class="section">{t("Space")}</div>
  <input placeholder={t("Name (optional)")} bind:value={label} onkeydown={(e) => e.key === "Enter" && create()} />
  <label class="field"><span>{t("Agent starten")}</span>
    <select bind:value={agent}>
      <option value="omp">omp</option>
      <option value="claude">Claude Code</option>
      <option value="codex">Codex</option>
      <option value="">{t("Keiner (Shell)")}</option>
    </select>
  </label>

  {#if error}<div class="err">{error}</div>{/if}
  <div class="buttons">
    <span class="dim small grow">{mod}↩</span>
    <button class="btn" onclick={onClose}>{t("Abbrechen")}</button>
    <button class="btn primary" disabled={!valid || busy} onclick={create}>{busy ? "…" : t("Anlegen")}</button>
  </div>
</Modal>

<style>
  .seg { display: grid; grid-template-columns: 1fr 1fr; background: var(--card); border: 1px solid var(--border); border-radius: 9px; padding: 2px; }
  .seg button { all: unset; cursor: pointer; text-align: center; padding: 5px 10px; border-radius: 7px; color: var(--muted); }
  .seg button.on { background: var(--raised); color: var(--fg); box-shadow: 0 0 0 1px var(--border); }
  .seg button:disabled { opacity: .45; cursor: default; }
  .seg button:focus-visible { outline: 2px solid var(--accent); }
  .section { margin: 4px 0 -6px; }
  .field { display: grid; grid-template-columns: 110px 1fr; align-items: center; gap: 10px; }
  .field > span { color: var(--muted); }
  .buttons { display: flex; align-items: center; gap: 8px; }
</style>
