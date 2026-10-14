<script lang="ts">
  import * as api from "../api";
  import type { ModelList } from "../api";
  import { t } from "../i18n";
  import Modal from "./Modal.svelte";

  let { server, kind, current, onClose, onPick, pickLabel }: {
    server: string; kind: string; current?: string; onClose: () => void;
    onPick: (model: string, level?: string) => void | Promise<void>; pickLabel?: string;
  } = $props();

  let list = $state<ModelList | null>(null);
  let search = $state("");
  let model = $state<string | undefined>();
  let level = $state("");
  let error = $state("");
  api.models(server, kind).then((l) => (list = l)).catch((e) => (error = String(e)));

  const shown = $derived((list?.models ?? []).filter((m) => !search || `${m.name} ${m.id}`.toLowerCase().includes(search.toLowerCase())));
  const groups = $derived([...new Set(shown.map((m) => m.group))]);
</script>

<Modal title={t("Modell")} {onClose}>
  {#if current}<div class="muted">{current}</div>{/if}
  <input placeholder={t("Modell suchen")} bind:value={search} />
  {#if list?.levels.length}
    <label>{list.levelName}
      <select bind:value={level}><option value="">{t("Standard")}</option>{#each list.levels as l}<option value={l}>{l}</option>{/each}</select>
    </label>
  {/if}
  <div class="list">
    {#if !list && !error}<div class="dim">{t("Lädt …")}</div>{/if}
    {#each groups as g}
      <div class="group">{g}</div>
      {#each shown.filter((m) => m.group === g) as m}
        <button class="model" class:sel={model === m.id} onclick={() => (model = m.id)}>
          {m.name} <span class="mono dim">{m.id}</span>
        </button>
      {/each}
    {/each}
    {#if error}<div class="err">{error}</div>{/if}
  </div>
  <div class="buttons">
    <button class="btn" onclick={onClose}>{t("Abbrechen")}</button>
    <button class="btn primary" disabled={!model} onclick={() => model && onPick(model, level || undefined)}>{pickLabel ?? t("Wechseln")}</button>
  </div>
  {#if kind === "omp" && !pickLabel}<div class="dim">{t("Gilt nur für diese Sitzung.")}</div>{/if}
</Modal>

<style>
  .list { max-height: 46vh; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
  .group { color: var(--muted); font-size: 12px; margin-top: 8px; text-transform: uppercase; }
  .model { all: unset; cursor: pointer; padding: 6px 8px; border-radius: 6px; }
  .model:hover { background: var(--card); }
  .model.sel { background: color-mix(in srgb, var(--accent) 25%, transparent); }
  .buttons { display: flex; justify-content: flex-end; gap: 8px; }
  label { display: flex; gap: 8px; align-items: center; }
  .err { color: var(--red); }
</style>
