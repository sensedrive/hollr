<script lang="ts">
  import * as api from "../api";
  import { t } from "../i18n";
  import Modal from "./Modal.svelte";
  let { onClose, onPaired }: { onClose: () => void; onPaired: () => void } = $props();
  let link = $state("");
  let name = $state("Desktop");
  let busy = $state(false);
  let error = $state("");
  async function go() {
    busy = true; error = "";
    try { await api.pair(link, name); onPaired(); } catch (e) { error = String(e); }
    busy = false;
  }
</script>

<Modal title={t("Server koppeln")} {onClose}>
  <div class="muted">{t("Auf dem Server `hollr pair --link` ausführen und den Link hier einfügen.")}</div>
  <input class="mono" placeholder="hollr://pair?c=…" bind:value={link} />
  <label>{t("Gerätename")} <input bind:value={name} /></label>
  {#if error}<div style="color: var(--red)">{error}</div>{/if}
  <div style="display:flex; justify-content:flex-end; gap:8px">
    <button class="btn" onclick={onClose}>{t("Abbrechen")}</button>
    <button class="btn primary" disabled={busy || !link.startsWith("hollr://pair")} onclick={go}>{busy ? "…" : t("Koppeln")}</button>
  </div>
</Modal>
