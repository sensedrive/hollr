<script lang="ts">
  // Searchable model list with thinking / effort level and recently used models.
  // Two modes: switch a running session (pick, then confirm) or choose for a new session (`instant`: a click picks).
  import { tick } from "svelte";
  import * as api from "../api";
  import type { ModelList } from "../api";
  import { t } from "../i18n";
  import Modal from "./Modal.svelte";

  let { server, kind, current, onClose, onPick, pickLabel, model: initialModel, level: initialLevel, onPickDefault, instant = false }: {
    server: string; kind: string; current?: string; onClose: () => void;
    onPick: (model: string, level?: string) => void | Promise<void>; pickLabel?: string;
    /** preselected model / level */
    model?: string; level?: string;
    /** offers "Standard des Agents" (no model) – for new sessions */
    onPickDefault?: (level?: string) => void;
    /** a click on a model picks it right away (no confirm button) */
    instant?: boolean;
  } = $props();

  // ---- recently used models per agent kind
  const RKEY = (k: string) => `hollr.models.recent.${k}`;
  function recentIds(k: string): string[] {
    try { return JSON.parse(localStorage.getItem(RKEY(k)) ?? "[]"); } catch { return []; }
  }
  function addRecent(id: string, k: string) {
    try { localStorage.setItem(RKEY(k), JSON.stringify([id, ...recentIds(k).filter((x) => x !== id)].slice(0, 6))); } catch {}
  }

  let list = $state<ModelList | null>(null);
  let search = $state("");
  // svelte-ignore state_referenced_locally
  let model = $state<string | undefined>(initialModel);
  // svelte-ignore state_referenced_locally
  let level = $state(initialLevel ?? "");
  let error = $state("");
  let busy = $state(false);
  let reloading = $state(false);
  let active = $state(0);
  let listEl = $state<HTMLDivElement>();

  async function load(refresh = false) {
    try {
      list = refresh ? await api.gate<ModelList>(server, `models ${kind} refresh`) : await api.models(server, kind);
      error = "";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  load();

  async function reload() { reloading = true; await load(true); reloading = false; }

  const ctx = (n?: number) => (!n ? "" : n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : `${Math.round(n / 1000)}k`);
  const detail = (m: ModelList["models"][number]) => [m.id, ctx(m.context)].filter(Boolean).join(" · ");

  type Item = { key: string; id?: string; name: string; detail?: string; group: string };
  const items = $derived.by(() => {
    const models = list?.models ?? [];
    const q = search.trim().toLowerCase();
    const out: Item[] = [];
    if (!q && onPickDefault) out.push({ key: "default", name: t("Standard des Agents"), group: "" });
    if (!q)
      for (const id of recentIds(kind)) {
        const m = models.find((x) => x.id === id);
        if (m) out.push({ key: `recent:${m.id}`, id: m.id, name: m.name, detail: m.id, group: t("Zuletzt") });
      }
    for (const m of models)
      if (!q || `${m.name} ${m.id}`.toLowerCase().includes(q)) out.push({ key: m.id, id: m.id, name: m.name, detail: detail(m), group: m.group });
    return out;
  });
  const groups = $derived([...new Set(items.map((i) => i.group))]);

  $effect(() => { void search; active = 0; });

  async function pick(item: Item) {
    if (!item.id) {
      onPickDefault?.(level || undefined);
      return;
    }
    model = item.id;
    if (instant) await confirm();
  }

  async function confirm() {
    if (!model || busy) return;
    busy = true; error = "";
    addRecent(model, kind);
    try { await onPick(model, level || undefined); } catch (e) { error = e instanceof Error ? e.message : String(e); }
    busy = false;
  }

  async function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if ((e.target as HTMLElement).matches("select, button")) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = Math.max(0, Math.min(items.length - 1, active + (e.key === "ArrowDown" ? 1 : -1)));
      await tick();
      listEl?.querySelector(".model.active")?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if ((e.metaKey || e.ctrlKey) && !instant) { confirm(); return; }
      const item = items[active];
      if (!item) return;
      if (!instant && item.id && model === item.id) confirm();
      else pick(item);
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<Modal title={t("Modell")} {onClose}>
  {#if current}<div class="cur"><span class="muted">{t("Aktuell")}</span><span class="mono small">{current}</span></div>{/if}
  <div class="top">
    <!-- svelte-ignore a11y_autofocus -->
    <input class="grow" placeholder={t("Modell suchen")} bind:value={search} autofocus />
    {#if list?.levels.length}
      <label class="lvl"><span class="muted">{list.levelName}</span>
        <select bind:value={level}><option value="">{t("Standard")}</option>{#each list.levels as l}<option value={l}>{l}</option>{/each}</select>
      </label>
    {/if}
    <button class="btn" title={t("Liste neu laden")} disabled={reloading} onclick={reload}>{reloading ? "…" : "↻"}</button>
  </div>
  <div class="list" bind:this={listEl}>
    {#if !list && !error}
      {#each Array(8) as _, i}
        <div class="sk"><div class="skeleton" style="height:13px; width:{[40, 55, 35, 50, 45, 60, 38, 48][i]}%"></div>
          <div class="skeleton" style="height:10px; width:{[30, 40, 25, 35, 28, 42, 30, 33][i]}%"></div></div>
      {/each}
    {/if}
    {#each groups as g}
      {#if g}<div class="group">{g}</div>{/if}
      {#each items.filter((i) => i.group === g) as item (item.key)}
        {@const idx = items.indexOf(item)}
        <button class="model" class:active={idx === active} class:sel={item.id ? model === item.id : !model && !!onPickDefault}
          onmouseenter={() => (active = idx)} onclick={() => pick(item)} ondblclick={() => !instant && item.id && confirm()}>
          <span class="grow"><span class="name">{item.name}</span>
            {#if item.detail}<span class="mono dim small ellipsis det">{item.detail}</span>{/if}</span>
          {#if item.id ? model === item.id : !model && !!onPickDefault}<span class="check">✓</span>{/if}
        </button>
      {/each}
    {/each}
    {#if list && !items.length}<div class="dim small pad">{t("Keine Treffer")}</div>{/if}
    {#if error}<div class="err">{error}</div>{/if}
  </div>
  {#if !instant}
    <div class="buttons">
      {#if kind === "omp" && !pickLabel}<span class="dim small grow">{t("Gilt nur für diese Sitzung – omps Standard bleibt.")}</span>
      {:else if kind === "claude" && !pickLabel}<span class="dim small grow">{t("Wechselt das Modell dieser Claude-Sitzung (/model).")}</span>
      {:else}<span class="grow"></span>{/if}
      <button class="btn" onclick={onClose}>{t("Abbrechen")}</button>
      <button class="btn primary" disabled={!model || busy} onclick={confirm}>{busy ? "…" : (pickLabel ?? t("Wechseln"))}</button>
    </div>
  {:else}
    <div class="dim small">{t("↑↓ wählen · ↩ übernehmen · esc schließen")}</div>
  {/if}
</Modal>

<style>
  .cur { display: flex; justify-content: space-between; gap: 12px; }
  .top { display: flex; gap: 8px; align-items: center; }
  .lvl { display: flex; gap: 6px; align-items: center; }
  .list { height: 50vh; overflow: auto; display: flex; flex-direction: column; gap: 1px; }
  .group { color: var(--muted); font-size: 11px; margin: 10px 0 2px; text-transform: uppercase; letter-spacing: .04em; }
  .model { all: unset; cursor: pointer; display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 6px; }
  .model.active { background: var(--card); }
  .model.sel { background: color-mix(in srgb, var(--accent) 22%, transparent); }
  .model .grow { display: grid; }
  .det { display: block; }
  .check { color: var(--accent); }
  .sk { display: grid; gap: 5px; padding: 7px 8px; }
  .pad { padding: 10px 8px; }
  .buttons { display: flex; align-items: center; gap: 8px; }
  .err { color: var(--red); }
</style>
