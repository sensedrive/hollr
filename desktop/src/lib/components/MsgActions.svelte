<script lang="ts">
  import Icon from "$lib/components/git/Icon.svelte";
  // Hover actions of one chat message (answer or own prompt): copy its text (markdown source) and, for
  // prompts, send it again. Sits in the parent's top corner – the parent needs `position: relative`.
  import { t } from "../i18n";
  import { copy } from "../serverapi";

  let { text, onResend, side = "end" }: {
    text: string; onResend?: (text: string) => void;
    /** corner it sits in – "start" where the message's time is on the right (own prompts) */
    side?: "start" | "end";
  } = $props();

  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function doCopy() {
    if (!(await copy(text))) return;
    copied = true;
    clearTimeout(timer);
    timer = setTimeout(() => (copied = false), 1200);
  }
</script>

<div class="acts" class:start={side === "start"} class:shown={copied}>
  <button title={t("Kopieren")} aria-label={t("Kopieren")} class:ok={copied} onclick={doCopy}><Icon name={copied ? "✓" : "⧉"} size={13} /></button>
  {#if onResend}
    <button title={t("Nochmal senden")} aria-label={t("Nochmal senden")} onclick={() => onResend(text)}><Icon name="↻" size={15} /></button>
  {/if}
</div>

<style>
  /* straddles the message's top edge: above the first text line, below the previous message */
  .acts { position: absolute; top: -16px; right: 6px; z-index: 2; display: flex; gap: 1px; padding: 2px; border-radius: 8px;
    background: var(--side); border: 1px solid var(--border); box-shadow: 0 3px 10px rgba(0, 0, 0, 0.25);
    opacity: 0; pointer-events: none; transition: opacity 0.12s; user-select: none; white-space: normal; }
  :global(:hover) > .acts, :global(:focus-within) > .acts, .acts.shown { opacity: 1; pointer-events: auto; }
  .acts.start { right: auto; left: 6px; }
  button { all: unset; cursor: pointer; width: 22px; height: 20px; display: grid; place-items: center; border-radius: 6px;
    font-size: 12.5px; color: var(--muted); }
  button:hover { color: var(--fg); background: color-mix(in srgb, var(--fg) 10%, transparent); }
  button:focus-visible { outline: 1px solid var(--accent); }
  .ok { color: var(--green); }
</style>
