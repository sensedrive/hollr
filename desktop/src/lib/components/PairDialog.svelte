<script lang="ts">
  // Pair a server with a link from `hollr pair --link` (desktop counterpart of iOS PairView).
  import * as api from "../api";
  import { t } from "../i18n";
  import { app } from "../store.svelte";
  import SetupCommands from "../views/settings/SetupCommands.svelte";
  import Modal from "./Modal.svelte";

  let { onClose, onPaired }: { onClose: () => void; onPaired: () => void } = $props();

  const isMac = navigator.platform.toLowerCase().includes("mac");
  let link = $state("");
  let name = $state(isMac ? "Mac" : "Desktop");
  let phase = $state<{ k: "input" } | { k: "pairing" } | { k: "done"; label: string } | { k: "failed"; message: string }>({ k: "input" });

  const valid = $derived(link.trim().startsWith("hollr://pair"));

  async function pair() {
    if (!valid || phase.k === "pairing") return;
    phase = { k: "pairing" };
    try {
      const server = await api.pair(link.trim(), name.trim() || (isMac ? "Mac" : "Desktop"));
      phase = { k: "done", label: server.label };
    } catch (e) {
      phase = { k: "failed", message: String(e instanceof Error ? e.message : e) };
    }
  }

  async function paste() {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (text) link = text;
      if (text.startsWith("hollr://pair")) pair();
    } catch {}
  }
</script>

<Modal title={t("Server koppeln")} onClose={phase.k === "done" ? onPaired : onClose}>
  {#if phase.k === "done"}
    <div class="result">
      <div class="big ok">✓</div>
      <b>{t("{label} ist gekoppelt", { label: phase.label })}</b>
    </div>
    <div class="actions"><button class="btn primary" onclick={onPaired}>{t("Fertig")}</button></div>
  {:else if phase.k === "failed"}
    <div class="result">
      <div class="big bad">✕</div>
      <div class="msg">{phase.message}</div>
    </div>
    <div class="actions">
      <button class="btn" onclick={onClose}>{t("Abbrechen")}</button>
      <button class="btn primary" onclick={() => (phase = { k: "input" })}>{t("Nochmal versuchen")}</button>
    </div>
  {:else}
    <label class="field">
      <span class="muted small">{t("Gerätename")}</span>
      <input bind:value={name} disabled={phase.k === "pairing"} />
      <span class="dim small">{t("So erscheint dieser Computer in `hollr devices` auf dem Server.")}</span>
    </label>
    <label class="field">
      <span class="muted small">{t("Kopplungslink")}</span>
      <div class="linkrow">
        <input class="mono grow" placeholder="hollr://pair?c=…" bind:value={link} disabled={phase.k === "pairing"}
          onkeydown={(e) => e.key === "Enter" && pair()} />
        <button class="btn" onclick={paste} disabled={phase.k === "pairing"}>{t("Einfügen")}</button>
      </div>
      <span class="dim small">{t("Auf dem Server `hollr pair --link` ausführen und den Link hier einfügen.")}</span>
    </label>
    {#if phase.k === "pairing"}
      <div class="skeleton bar"></div>
    {/if}
    <div class="actions">
      <button class="btn" onclick={onClose}>{t("Abbrechen")}</button>
      <button class="btn primary" disabled={!valid || phase.k === "pairing"} onclick={pair}>
        {phase.k === "pairing" ? t("Kopple …") : t("Koppeln")}
      </button>
    </div>
    <details open={!app.servers.length}>
      <summary class="muted">{t("Noch kein Hollr auf dem Server?")}</summary>
      <div class="cmds"><SetupCommands /></div>
    </details>
  {/if}
</Modal>

<style>
  .field { display: grid; gap: 4px; }
  .linkrow { display: flex; gap: 8px; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
  .result { display: grid; justify-items: center; gap: 8px; padding: 14px 0; text-align: center; }
  .big { font-size: 40px; line-height: 1; }
  .ok { color: var(--green); }
  .bad { color: var(--red); }
  .msg { white-space: pre-wrap; }
  .bar { height: 6px; }
  details { border-top: 1px solid var(--border); padding-top: 10px; }
  summary { cursor: pointer; }
  .cmds { padding-top: 10px; }
</style>
