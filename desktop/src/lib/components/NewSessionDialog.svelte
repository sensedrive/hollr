<script lang="ts">
  // Open a new session: agent (omp / Claude / ChatGPT-Codex) or a plain terminal, model + level, and where it runs.
  // Missing agents can be installed on the server right here (`hollr gate tools`).
  import * as api from "../api";
  import type { Server, Workspace } from "../api";
  import { t } from "../i18n";
  import { dialogs, go } from "../store.svelte";
  import Modal from "./Modal.svelte";
  import ModelDialog from "./ModelDialog.svelte";

  let { servers, trees, onClose, onCreated }: {
    servers: Server[]; trees: Record<string, Workspace[]>; onClose: () => void; onCreated: (server: string, pane: string) => void;
  } = $props();

  const HOME = "__home__";
  const NEW = "__new__";
  const AGENTS = [
    { kind: "omp", name: "omp", note: "Oh My Pi – mit Live-Sprachmodus" },
    { kind: "claude", name: "Claude Code", note: "Text-Chat" },
    { kind: "codex", name: "ChatGPT (Codex)", note: "Text-Chat" },
    { kind: "shell", name: "Terminal", note: "Shell ohne Agent" },
  ];

  // preset from the store (e.g. "new session in this space")
  const preset = dialogs.newSession ?? {};
  // svelte-ignore state_referenced_locally
  let server = $state(servers.some((s) => s.id === preset.server) ? preset.server! : (servers[0]?.id ?? ""));
  let kind = $state("omp");
  let installed = $state<string[]>([]);
  let kindsLoaded = $state(false);
  let workspace = $state(preset.ws ?? HOME);
  let folder = $state("");
  let label = $state("");
  let model = $state<string | undefined>();
  let level = $state<string | undefined>();
  let picking = $state(false);
  let busy = $state(false);
  let error = $state("");
  let installing = $state<string | null>(null);

  const srv = $derived(servers.find((s) => s.id === server));
  const workspaces = $derived(trees[server] ?? []);
  const available = (k: string) => !kindsLoaded || !installed.length || installed.includes(k) || k === "shell";

  $effect(() => {
    const id = server;
    kindsLoaded = false;
    api.kinds(id).then((k) => {
      if (id !== server) return;
      installed = k;
      kindsLoaded = true;
      if (k.length && !k.includes(kind) && kind !== "shell") kind = k[0]!;
    }).catch(() => (kindsLoaded = true));
  });
  // a workspace of another server makes no sense
  $effect(() => {
    if (workspace !== HOME && workspace !== NEW && !workspaces.some((w) => w.id === workspace) && trees[server]) workspace = HOME;
  });

  function choose(k: string) {
    if (!available(k)) return;
    if (k !== kind) { model = undefined; level = undefined; }
    kind = k;
  }

  interface ToolState { name: string; running: boolean; exit?: number; log?: string }

  /** Installs a missing agent on the server, then selects it. */
  async function install(agent: string) {
    installing = agent; error = "";
    const id = server;
    try {
      await api.gate<{ tools: ToolState[] }>(id, "tools", { op: "run", name: agent });
      for (let i = 0; i < 150; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const tool = (await api.gate<{ tools: ToolState[] }>(id, "tools", {})).tools.find((x) => x.name === agent);
        if (tool && !tool.running) {
          if (tool.exit === 0) {
            installed = await api.kinds(id).catch(() => installed);
            kind = agent;
          } else {
            error = t("Installation fehlgeschlagen: {msg}", { msg: tool.log?.split("\n").pop() ?? "" });
          }
          break;
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    installing = null;
  }

  function expand(path: string, user: string) {
    let p = path.trim();
    if (p.startsWith("~")) p = `/home/${user}${p.slice(1)}`;
    if (user === "root" && p.startsWith("/home/root")) p = `/root${p.slice("/home/root".length)}`;
    return p;
  }

  async function create() {
    if (busy || !srv || !available(kind)) return;
    busy = true; error = "";
    const ws = workspace === HOME || workspace === NEW ? undefined : workspace;
    const cwd = workspace === NEW ? expand(folder, srv.user) : "";
    const name = label.trim() || AGENTS.find((a) => a.kind === kind)!.name;
    try {
      const pane = await api.newChat(server, {
        kind, label: name,
        ...(ws ? { workspace: ws } : cwd ? { cwd } : {}),
        ...(kind !== "shell" ? { model, level } : {}),
      });
      onCreated(server, pane);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    busy = false;
  }

  function onKey(e: KeyboardEvent) {
    if (picking) return;
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); create(); }
  }

  const footer = $derived(
    workspace === HOME
      ? t("Startet im Home-Verzeichnis von {user} – ohne Projekt.", { user: srv?.user ?? t("dir") })
      : workspace === NEW
        ? t("Leer = Home-Verzeichnis. Ordner mit ~ werden auf dem Server aufgelöst.")
        : t("Öffnet als neuer Tab im Ordner dieses Workspaces."),
  );
  const mod = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl+";
</script>

<svelte:window onkeydown={onKey} />

<Modal title={t("Neue Sitzung")} {onClose}>
  {#if servers.length > 1}
    <label class="field"><span>{t("Server")}</span>
      <select bind:value={server}>{#each servers as s}<option value={s.id}>{s.label}</option>{/each}</select></label>
  {/if}

  <div class="section">{t("Was")}</div>
  <div class="kinds" role="radiogroup">
    {#each AGENTS as a}
      {@const ok = available(a.kind)}
      <div class="kind" class:sel={kind === a.kind && ok} class:off={!ok}>
        <button class="pick" role="radio" aria-checked={kind === a.kind} disabled={!ok} onclick={() => choose(a.kind)}
          ondblclick={() => ok && create()}>
          <span class="name">{t(a.name)}</span>
          <span class="note small">
            {#if ok}{t(a.note)}
            {:else if installing === a.kind}{t("wird installiert …")}
            {:else}{t("auf {server} nicht installiert", { server: srv?.label ?? t("dem Server") })}{/if}
          </span>
        </button>
        {#if !ok}
          {#if installing === a.kind}
            <span class="skeleton inst"></span>
          {:else}
            <button class="btn small installbtn" disabled={!!installing} onclick={() => install(a.kind)}>{t("Installieren")}</button>
          {/if}
        {:else if kind === a.kind}<span class="check">✓</span>{/if}
      </div>
    {/each}
  </div>
  {#if !kindsLoaded}<div class="dim small">{t("Prüfe installierte Agents …")}</div>{/if}

  {#if kind !== "shell"}
    <button class="modelbtn" onclick={() => (picking = true)}>
      <span class="muted">{t("Modell")}</span>
      <span class="grow ellipsis val">{[model ?? t("Standard"), level].filter(Boolean).join(" · ")}</span>
      <span class="dim">›</span>
    </button>
    <div class="dim small hint">{t("Mit Suche, zuletzt genutzten Modellen und {level}-Stufe.", { level: kind === "omp" ? "Thinking" : "Effort" })}</div>
  {/if}

  <div class="section">{t("Wo")}</div>
  <label class="field"><span>{t("Workspace")}</span>
    <select bind:value={workspace}>
      <option value={HOME}>{t("Kein Projekt (Home)")}</option>
      <option value={NEW}>{t("Neuer Workspace")}</option>
      {#if workspaces.length}
        <optgroup label={t("Workspaces")}>{#each workspaces as w}<option value={w.id}>{w.label}</option>{/each}</optgroup>
      {/if}
    </select>
  </label>
  {#if workspace === NEW}
    <!-- svelte-ignore a11y_autofocus -->
    <input class="mono" placeholder={t("Ordner auf dem Server, z. B. ~/projects/my-app")} bind:value={folder} autofocus
      autocomplete="off" spellcheck="false" onkeydown={(e) => e.key === "Enter" && create()} />
  {/if}
  <input placeholder={t("Name (optional)")} bind:value={label} onkeydown={(e) => e.key === "Enter" && create()} />
  <div class="dim small hint">{footer}</div>

  {#if error}<div class="err">{error}</div>{/if}
  <div class="buttons">
    {#if srv}<button class="btn link small" onclick={() => { onClose(); go({ view: "tools", server }); }}>{t("Werkzeuge …")}</button>{/if}
    <span class="grow dim small">{mod}↩</span>
    <button class="btn" onclick={onClose}>{t("Abbrechen")}</button>
    <button class="btn primary" disabled={busy || !srv || !available(kind)} onclick={create}>{busy ? "…" : t("Öffnen")}</button>
  </div>
</Modal>

{#if picking}
  <ModelDialog {server} {kind} model={model} level={level} instant pickLabel={t("Übernehmen")} onClose={() => (picking = false)}
    onPick={(m, l) => { model = m; level = l; picking = false; }}
    onPickDefault={(l) => { model = undefined; level = l; picking = false; }} />
{/if}

<style>
  .section { margin: 4px 0 -6px; }
  .field { display: grid; grid-template-columns: 110px 1fr; align-items: center; gap: 10px; }
  .field > span { color: var(--muted); }
  .kinds { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .kind { position: relative; display: flex; align-items: center; gap: 8px; background: var(--card); border: 1px solid var(--border);
    border-radius: 10px; padding-right: 10px; transition: border-color .12s; }
  .kind:hover:not(.off) { border-color: color-mix(in srgb, var(--accent) 60%, var(--border)); }
  .kind.sel { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 16%, var(--card)); }
  .pick { all: unset; flex: 1; min-width: 0; display: grid; padding: 9px 12px; cursor: pointer; border-radius: 10px; }
  .pick:focus-visible { outline: 2px solid var(--accent); }
  .pick:disabled { cursor: default; }
  .off .name { color: var(--muted); }
  .note { color: var(--muted); }
  .check { color: var(--accent); }
  .installbtn { padding: 3px 9px; flex: none; }
  .inst { width: 60px; height: 20px; flex: none; }
  .modelbtn { all: unset; box-sizing: border-box; cursor: pointer; display: flex; gap: 10px; align-items: center; padding: 9px 12px;
    border: 1px solid var(--border); border-radius: 8px; background: var(--raised); }
  .modelbtn:hover, .modelbtn:focus-visible { border-color: var(--accent); }
  .val { text-align: right; }
  .hint { margin-top: -6px; }
  .buttons { display: flex; align-items: center; gap: 8px; }
  .link { background: none; border-color: transparent; color: var(--muted); padding-left: 0; }
  .link:hover { color: var(--accent); border-color: transparent; }
</style>
