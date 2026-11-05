<script lang="ts">
  import Icon from "$lib/components/git/Icon.svelte";
  // Pair a server with a link from `hollr pair --link` or the one-time code `hollr pair` shows
  // (desktop counterpart of iOS PairView).
  import * as api from "../api";
  import { t } from "../i18n";
  import { formatCode, isCompleteCode, isPastedCode, isTailscaleAddress } from "../pairingCode";
  import { app } from "../store.svelte";
  import SetupCommands from "../views/settings/SetupCommands.svelte";
  import Modal from "./Modal.svelte";

  let { onClose, onPaired }: { onClose: () => void; onPaired: () => void } = $props();

  const isMac = navigator.platform.toLowerCase().includes("mac");
  let method = $state<"link" | "code">("link");
  let link = $state("");
  let code = $state("");
  let codeInput = $state<HTMLInputElement>();
  let name = $state(isMac ? "Mac" : "Desktop");
  let phase = $state<{ k: "input" } | { k: "pairing" } | { k: "done"; label: string } | { k: "failed"; message: string }>({ k: "input" });

  const isLink = (text: string) => text.trim().startsWith("hollr://pair");
  const valid = $derived(method === "link" ? isLink(link) : isCompleteCode(code));

  $effect(() => {
    if (method === "code" && phase.k === "input") codeInput?.focus();
  });

  async function pair() {
    if (!valid || phase.k === "pairing") return;
    phase = { k: "pairing" };
    const device = name.trim() || (isMac ? "Mac" : "Desktop");
    try {
      const server = method === "link" ? await api.pair(link.trim(), device) : await api.pairCode(code, device);
      phase = { k: "done", label: server.label };
    } catch (e) {
      phase = { k: "failed", message: errorText(String(e instanceof Error ? e.message : e)) };
    }
  }

  /** Code errors come as `otp:<kind>` (`otp:unreachable:<ip>`), everything else is already worded. */
  function errorText(raw: string): string {
    const [tag, kind, ip = ""] = raw.split(":");
    if (tag !== "otp") return raw;
    switch (kind) {
      case "format":
        return t("Der Code hat 16 Zeichen, z. B. K7Q2-M9XA-3PLD-W8RT.");
      case "wrong":
        return t("Der Code stimmt nicht. Bitte genau so eingeben, wie er am Server steht.");
      case "locked":
        return t("Zu viele falsche Versuche – der Code ist gesperrt. Am Server einen neuen erzeugen („n“ + Enter).");
      case "expired":
        return t("Der Code ist abgelaufen oder wurde schon benutzt. Am Server einen neuen erzeugen: hollr pair");
      case "unreachable":
        return isTailscaleAddress(ip)
          ? t("Der Server ({ip}) ist nicht erreichbar. Ist Tailscale auf diesem Computer verbunden und läuft „hollr pair“ am Server noch?", { ip })
          : t("Der Server ({ip}) ist nicht erreichbar. Gleiches Netzwerk? Läuft „hollr pair“ am Server noch?", { ip });
      default:
        return t("Die Antwort des Servers passt nicht zum Code.");
    }
  }

  /** Link or code from the clipboard – whichever it is, and pair right away. */
  function take(text: string): boolean {
    if (isLink(text)) {
      method = "link";
      link = text.trim();
    } else if (isPastedCode(text)) {
      method = "code";
      code = formatCode(text);
    } else return false;
    pair();
    return true;
  }

  async function paste() {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text || take(text)) return;
      if (method === "link") link = text;
      else code = formatCode(text);
    } catch {}
  }

  function onPaste(e: ClipboardEvent) {
    if (take(e.clipboardData?.getData("text/plain") ?? "")) e.preventDefault();
  }

  function onCodeInput(e: Event & { currentTarget: HTMLInputElement }) {
    code = formatCode(e.currentTarget.value);
    e.currentTarget.value = code;
  }
</script>

<Modal title={t("Server koppeln")} onClose={phase.k === "done" ? onPaired : onClose}>
  {#if phase.k === "done"}
    <div class="result">
      <div class="big ok"><Icon name="✓" size={15} /></div>
      <b>{t("{label} ist gekoppelt", { label: phase.label })}</b>
    </div>
    <div class="actions"><button class="btn primary" onclick={onPaired}>{t("Fertig")}</button></div>
  {:else if phase.k === "failed"}
    <div class="result">
      <div class="big bad"><Icon name="✕" size={15} /></div>
      <div class="msg">{phase.message}</div>
    </div>
    <div class="actions">
      <button class="btn" onclick={onClose}>{t("Abbrechen")}</button>
      <button class="btn primary" onclick={() => (phase = { k: "input" })}>{t("Nochmal versuchen")}</button>
    </div>
  {:else}
    <div class="seg" role="radiogroup" aria-label={t("Methode")}>
      <button role="radio" aria-checked={method === "link"} class:on={method === "link"} disabled={phase.k === "pairing"}
        onclick={() => (method = "link")}>{t("Link")}</button>
      <button role="radio" aria-checked={method === "code"} class:on={method === "code"} disabled={phase.k === "pairing"}
        onclick={() => (method = "code")}>{t("Code")}</button>
    </div>
    <label class="field">
      <span class="muted small">{t("Gerätename")}</span>
      <input bind:value={name} disabled={phase.k === "pairing"} />
      <span class="dim small">{t("So erscheint dieser Computer in `hollr devices` auf dem Server.")}</span>
    </label>
    {#if method === "link"}
      <label class="field">
        <span class="muted small">{t("Kopplungslink")}</span>
        <div class="linkrow">
          <input class="mono grow" placeholder="hollr://pair?c=…" bind:value={link} disabled={phase.k === "pairing"}
            onpaste={onPaste} onkeydown={(e) => e.key === "Enter" && pair()} />
          <button class="btn" onclick={paste} disabled={phase.k === "pairing"}>{t("Einfügen")}</button>
        </div>
        <span class="dim small">{t("Auf dem Server `hollr pair --link` ausführen und den Link hier einfügen.")}</span>
      </label>
    {:else}
      <label class="field">
        <span class="muted small">{t("Kopplungscode")}</span>
        <div class="linkrow">
          <input bind:this={codeInput} class="mono grow code" placeholder="XXXX-XXXX-XXXX-XXXX" value={code}
            spellcheck="false" autocomplete="off" autocapitalize="characters" disabled={phase.k === "pairing"}
            oninput={onCodeInput} onpaste={onPaste} onkeydown={(e) => e.key === "Enter" && pair()} />
          <button class="btn" onclick={paste} disabled={phase.k === "pairing"}>{t("Einfügen")}</button>
        </div>
        <span class="dim small">{t("Auf dem Server `hollr pair` ausführen – der Code steht unter dem QR-Code, gilt 10 Minuten und nur einmal. Von unterwegs: am Server „Tailscale / Fernzugriff“ wählen und Tailscale auf diesem Computer verbinden.")}</span>
      </label>
    {/if}
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
  .seg { display: grid; grid-template-columns: 1fr 1fr; background: var(--card); border: 1px solid var(--border); border-radius: 9px; padding: 2px; }
  .seg button { all: unset; cursor: pointer; text-align: center; padding: 5px 10px; border-radius: 7px; color: var(--muted); }
  .seg button.on { background: var(--raised); color: var(--fg); box-shadow: 0 0 0 1px var(--border); }
  .seg button:disabled { opacity: .45; cursor: default; }
  .seg button:focus-visible { outline: 2px solid var(--accent); }
  .field { display: grid; gap: 4px; }
  .linkrow { display: flex; gap: 8px; }
  .code { font-size: 17px; font-weight: 600; letter-spacing: .08em; text-align: center; }
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
