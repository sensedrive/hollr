<script lang="ts">
  // The input card (Composer.swift): text on top, actions below. Enter sends, Shift+Enter adds a line,
  // ↑ in an empty field brings back the last message. ">_" sends single keys to the pane.
  import type { Snippet } from "svelte";
  import { t } from "../i18n";
  import { pushRecall } from "../drafts";

  let {
    placeholder, keysTitle, translucent = false, disabled = false, onSend, onKeys, top, trailing, value = $bindable(""),
    sent = $bindable([]),
  }: {
    placeholder: string;
    keysTitle: string;
    translucent?: boolean;
    disabled?: boolean;
    /** returns false when sending failed (text stays) */
    onSend: (text: string) => Promise<boolean> | boolean;
    onKeys: (keys: string[]) => void;
    /** extra row inside the card above the text (live strip) */
    top?: Snippet;
    /** extra buttons left of "send" (live button) */
    trailing?: Snippet;
    value?: string;
    /** ↑ history, newest first (bind it to keep it beyond this component) */
    sent?: string[];
  } = $props();

  const KEYS: [string, string][] = $derived([
    ["Enter", "enter"], ["Esc", "esc"], ["Tab", "tab"], ["↑", "up"], ["↓", "down"], ["←", "left"], ["→", "right"],
    [t("y (ja)"), "y"], [t("n (nein)"), "n"], ["Ctrl+C", "ctrl+c"], ["Ctrl+D", "ctrl+d"], ["Ctrl+L", "ctrl+l"],
  ]);
  /** always visible on wide windows */
  const QUICK: [string, string][] = [["Esc", "esc"], ["↑", "up"], ["↓", "down"], ["Tab", "tab"], ["⏎", "enter"], ["^C", "ctrl+c"]];

  let area: HTMLTextAreaElement | undefined = $state();
  let menu = $state(false);
  let recall = -1;
  const trimmed = $derived(value.trim());

  export function focus() {
    area?.focus();
  }

  // grow with the text (1 … 10 lines)
  $effect(() => {
    void value;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight, 220)}px`;
  });

  async function send() {
    const msg = trimmed;
    if (!msg || disabled) return;
    value = "";
    recall = -1;
    sent = pushRecall(sent, msg);
    const ok = await onSend(msg);
    // the owner may already have put it back (drafts) – never twice
    if (ok === false && !value.includes(msg)) value = value ? `${msg}\n${value}` : msg;
  }

  function onKey(e: KeyboardEvent) {
    if (e.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      send();
    } else if (e.key === "ArrowUp" && (!value || recall >= 0) && sent.length && area?.selectionStart === 0) {
      e.preventDefault();
      recall = Math.min(recall + 1, sent.length - 1);
      value = sent[recall] ?? "";
    } else if (e.key === "ArrowDown" && recall >= 0) {
      e.preventDefault();
      recall--;
      value = recall >= 0 ? (sent[recall] ?? "") : "";
    } else if (e.key === "Escape" && value === "" ) {
      area?.blur();
    }
  }

  function key(k: string) {
    menu = false;
    onKeys([k]);
  }
</script>

<svelte:window onclick={() => (menu = false)} />

<div class="composer" class:translucent>
  {#if top}{@render top()}{/if}
  <textarea bind:this={area} bind:value rows="1" {placeholder} {disabled} spellcheck="false" onkeydown={onKey}></textarea>
  <div class="actions">
    <div class="keys">
      <div class="menuwrap">
        <button class="term mono" title={keysTitle} aria-label={t("Tasten senden")} onclick={(e) => { e.stopPropagation(); menu = !menu; }}>&gt;_</button>
        {#if menu}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="menu" onclick={(e) => e.stopPropagation()}>
            <div class="mtitle">{keysTitle}</div>
            {#each KEYS as [label, k]}
              <button class="mitem" onclick={() => key(k)}>{label}<span class="mono dim">{k}</span></button>
            {/each}
          </div>
        {/if}
      </div>
      <div class="quick">
        {#each QUICK as [label, k]}
          <button class="key mono" title={k} onclick={() => onKeys([k])}>{label}</button>
        {/each}
      </div>
    </div>
    <div class="right">
      {#if trailing}{@render trailing()}{/if}
      <button class="send" class:on={!!trimmed} disabled={!trimmed || disabled} title={`${t("Senden")} (⏎)`} aria-label={t("Senden")} onclick={send}>↑</button>
    </div>
  </div>
</div>

<style>
  .composer { background: var(--raised); border: 1px solid color-mix(in srgb, var(--fg) 12%, transparent); border-radius: 22px;
    padding: 12px 14px 8px; display: flex; flex-direction: column; gap: 8px; transition: border-color 0.15s; container-type: inline-size; }
  .composer:focus-within { border-color: color-mix(in srgb, var(--accent) 60%, transparent); }
  .composer.translucent { background: color-mix(in srgb, var(--raised) 62%, transparent); backdrop-filter: blur(22px) saturate(1.4);
    -webkit-backdrop-filter: blur(22px) saturate(1.4); box-shadow: 0 8px 30px rgba(0, 0, 0, 0.25); }
  textarea { all: unset; box-sizing: border-box; width: 100%; resize: none; font-family: var(--mono); font-size: 13.5px; line-height: 1.5;
    min-height: 21px; max-height: 220px; overflow-y: auto; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--fg); }
  textarea::placeholder { color: var(--dim); }
  .actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .keys { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .quick { display: flex; gap: 4px; overflow: hidden; }
  .key { all: unset; cursor: pointer; font-size: 11px; color: var(--muted); padding: 2px 7px; border-radius: 6px;
    border: 1px solid color-mix(in srgb, var(--fg) 10%, transparent); }
  .key:hover { color: var(--fg); border-color: var(--accent); }
  @container (max-width: 520px) { .quick { display: none; } }
  .term { all: unset; cursor: pointer; font-weight: 600; font-size: 15px; padding: 2px 6px; border-radius: 6px; }
  .term:hover { background: color-mix(in srgb, var(--fg) 8%, transparent); }
  .menuwrap { position: relative; }
  .menu { position: absolute; bottom: calc(100% + 8px); left: -6px; z-index: 20; min-width: 220px; background: var(--side);
    border: 1px solid var(--border); border-radius: 12px; padding: 6px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35); }
  .mtitle { font-size: 11px; color: var(--muted); padding: 4px 8px 6px; }
  .mitem { all: unset; cursor: pointer; display: flex; justify-content: space-between; gap: 16px; width: calc(100% - 16px);
    padding: 5px 8px; border-radius: 7px; font-size: 13px; }
  .mitem:hover { background: color-mix(in srgb, var(--accent) 22%, transparent); }
  .mitem .dim { font-size: 11px; color: var(--dim); }
  .right { display: flex; align-items: center; gap: 8px; }
  .send { all: unset; cursor: default; width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; font-weight: 700;
    background: color-mix(in srgb, var(--fg) 10%, transparent); color: var(--muted); }
  .send.on { cursor: pointer; background: var(--accent); color: #fff; }
  .send.on:hover { filter: brightness(1.1); }
</style>
