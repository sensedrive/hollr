<script lang="ts">
  import * as api from "../api";
  import type { Server, Workspace } from "../api";
  import { t } from "../i18n";
  import Modal from "./Modal.svelte";
  import ModelDialog from "./ModelDialog.svelte";

  let { servers, trees, onClose, onCreated }: {
    servers: Server[]; trees: Record<string, Workspace[]>; onClose: () => void; onCreated: (server: string, pane: string) => void;
  } = $props();

  const KINDS = [["omp", "omp"], ["claude", "Claude Code"], ["codex", "Codex"], ["shell", "Terminal"]];
  let server = $state(servers[0]?.id ?? "");
  let kind = $state("omp");
  let installed = $state<string[]>([]);
  let workspace = $state("__home__");
  let folder = $state("");
  let label = $state("");
  let model = $state<string | undefined>();
  let level = $state<string | undefined>();
  let picking = $state(false);
  let busy = $state(false);
  let error = $state("");

  $effect(() => { if (server) api.kinds(server).then((k) => (installed = k)).catch(() => {}); });

  async function create() {
    busy = true; error = "";
    const srv = servers.find((s) => s.id === server)!;
    const ws = workspace === "__home__" || workspace === "__new__" ? undefined : workspace;
    let cwd = workspace === "__new__" ? folder.trim() : "";
    if (cwd.startsWith("~")) cwd = `/home/${srv.user}${cwd.slice(1)}`;
    try {
      const pane = await api.newChat(server, {
        kind, workspace: ws, cwd: cwd || undefined, label: label.trim() || KINDS.find((k) => k[0] === kind)![1],
        ...(kind !== "shell" ? { model, level } : {}),
      });
      onCreated(server, pane);
    } catch (e) { error = String(e); }
    busy = false;
  }
</script>

<Modal title={t("Neue Sitzung")} {onClose}>
  {#if servers.length > 1}
    <select bind:value={server}>{#each servers as s}<option value={s.id}>{s.label}</option>{/each}</select>
  {/if}
  <div class="muted">{t("Was")}</div>
  <div class="kinds">
    {#each KINDS as [k, name]}
      {@const ok = !installed.length || installed.includes(k)}
      <button class="kind" class:sel={kind === k} disabled={!ok} onclick={() => { kind = k; model = undefined; level = undefined; }}>
        {name}{#if !ok}<span class="dim"> · {t("nicht installiert")}</span>{/if}
      </button>
    {/each}
  </div>
  {#if kind !== "shell"}
    <button class="btn" onclick={() => (picking = true)}>{t("Modell")}: {[model ?? t("Standard"), level].filter(Boolean).join(" · ")}</button>
  {/if}
  <div class="muted">{t("Wo")}</div>
  <select bind:value={workspace}>
    <option value="__home__">{t("Kein Projekt (Home)")}</option>
    <option value="__new__">{t("Neuer Workspace")}</option>
    {#each trees[server] ?? [] as w}<option value={w.id}>{w.label}</option>{/each}
  </select>
  {#if workspace === "__new__"}<input class="mono" placeholder={`${t("Ordner auf dem Server")}, ~/projects/…`} bind:value={folder} />{/if}
  <input placeholder={t("Name (optional)")} bind:value={label} />
  {#if error}<div style="color: var(--red)">{error}</div>{/if}
  <div style="display:flex; justify-content:flex-end; gap:8px">
    <button class="btn" onclick={onClose}>{t("Abbrechen")}</button>
    <button class="btn primary" disabled={busy} onclick={create}>{busy ? "…" : t("Öffnen")}</button>
  </div>
</Modal>

{#if picking}
  <ModelDialog {server} {kind} pickLabel={t("Modell")} onClose={() => (picking = false)}
    onPick={(m, l) => { model = m; level = l; picking = false; }} />
{/if}

<style>
  .kinds { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .kind { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 8px; text-align: left; }
  .kind.sel { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 18%, transparent); }
  .kind:disabled { opacity: 0.5; cursor: default; }
</style>
