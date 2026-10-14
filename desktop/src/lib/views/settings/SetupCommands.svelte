<script lang="ts">
  // Copy-paste commands to install Hollr on a server and get the pairing link (iOS: SetupCommands in PairView).
  import { t } from "$lib/i18n";
  import { copy } from "$lib/serverapi";

  let os = $state<"linux" | "mac">(navigator.platform.toLowerCase().includes("mac") ? "mac" : "linux");
  let copied = $state("");

  const REPO = "sensedrive/hollr";
  const install = `curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash && ~/.local/bin/hollr pair --link`;

  const steps = $derived([
    ...(os === "mac" ? [{ title: "Entfernte Anmeldung (SSH) einschalten", cmd: "sudo systemsetup -setremotelogin on" }] : []),
    { title: "Auf dem Server ausführen", cmd: install },
    { title: "Schon installiert? Nur koppeln:", cmd: "hollr pair --link" },
  ]);

  async function doCopy(cmd: string) {
    if (await copy(cmd)) {
      copied = cmd;
      setTimeout(() => copied === cmd && (copied = ""), 1800);
    }
  }
</script>

<div class="setup">
  <div class="head">
    <b>{t("Server einrichten")}</b>
    <div class="seg" role="tablist">
      <button role="tab" aria-selected={os === "linux"} class:on={os === "linux"} onclick={() => (os = "linux")}>Linux</button>
      <button role="tab" aria-selected={os === "mac"} class:on={os === "mac"} onclick={() => (os = "mac")}>macOS</button>
    </div>
  </div>
  {#each steps as step (step.cmd)}
    <div class="step">
      <div class="muted small">{t(step.title)}</div>
      <div class="cmd">
        <code class="mono">{step.cmd}</code>
        <button class="copy" title={t("Befehl kopieren")} aria-label={t("Befehl kopieren")} onclick={() => doCopy(step.cmd)}>
          {copied === step.cmd ? "✓" : "⧉"}
        </button>
      </div>
    </div>
  {/each}
</div>

<style>
  .setup { display: grid; gap: 10px; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .seg { display: inline-flex; background: var(--raised); border: 1px solid var(--border); border-radius: 8px; padding: 2px; }
  .seg button { all: unset; cursor: pointer; padding: 2px 12px; border-radius: 6px; font-size: 12px; color: var(--muted); }
  .seg button.on { background: var(--card); color: var(--fg); box-shadow: 0 0 0 1px var(--border); }
  .step { display: grid; gap: 4px; }
  .cmd { display: flex; align-items: flex-start; gap: 8px; background: color-mix(in srgb, var(--fg) 6%, transparent); border-radius: 10px; padding: 8px 10px; }
  code { flex: 1; min-width: 0; font-size: 12px; white-space: pre-wrap; word-break: break-all; user-select: text; }
  .copy { all: unset; cursor: pointer; color: var(--muted); width: 22px; text-align: center; }
  .copy:hover { color: var(--accent); }
</style>
