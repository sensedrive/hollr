<script lang="ts">
  // bash / eval: the command, the last 8 output lines (click for everything the server sent), a footer with
  // wall time and exit code; copy buttons for command and output. Clicking only toggles when nothing is selected.
  import type { ToolCall } from "../../api";
  import { duration, shortPath } from "../../agent";
  import { outTail } from "../../chatTools";
  import { t } from "../../i18n";
  import Glyph from "./Glyph.svelte";
  import More from "./More.svelte";

  let { c, tip, copy }: { c: ToolCall; tip: string; copy: (s: string) => void } = $props();

  let open = $state(false);
  const tail = $derived(outTail(c, open));
  /** lines the server didn't send at all (it keeps the last 60) */
  const unsent = $derived(tail.earlier - tail.more);
  const toggle = () => {
    if (!window.getSelection()?.toString()) open = !open;
  };
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="frame {c.status}" class:click={!open} onclick={toggle} title={open ? tip : `${tip ? `${tip} · ` : ""}${t("Klicken für mehr Ausgabe")}`}>
  {#if c.name === "eval"}
    <div class="hrow"><Glyph status={c.status} ok="λ" color="var(--orange)" /> <b class="ellipsis">{c.detail ?? "Eval"}</b></div>
  {:else}
    <div class="cmd sel" class:clamp3={!open}><span class="dim">{"$ "}</span>{c.detail ?? ""}</div>
  {/if}
  {#if tail.lines.length}
    <hr />
    <!-- the hidden lines are the earlier ones (output is a tail), so their switch sits on top like omp's -->
    {#if tail.more > 0 || (open && (c.out?.length ?? 0) > 8)}
      <More {open} hidden={tail.more} unit="earlier" ontoggle={() => (open = !open)} />
    {/if}
    {#if unsent > 0 && (open || tail.more === 0)}
      <div class="dim">{t("… {n} frühere Zeilen nicht übertragen", { n: unsent })}</div>
    {/if}
    <pre>{tail.lines.join("\n")}</pre>
  {:else if c.status === "error" && c.result}
    <pre class="err" class:clamp4={!open}>{c.result}</pre>
  {/if}
  <div class="foot hrow mid">
    {#if c.status === "running"}
      <span class="braille acc"></span> <span class="muted">{t("läuft")}{c.ms !== undefined ? ` · ${duration(c.ms)}` : ""}</span>
    {:else}
      {#if c.exit !== undefined}<span class="chip" class:bad={c.exit !== 0} class:good={c.exit === 0}>Exit {c.exit}</span>
      {:else if c.status === "error"}<span class="chip bad">{t("Fehler")}</span>{/if}
      {#if c.ms !== undefined}<span class="dim">{duration(c.ms)}</span>{/if}
      {#if c.bg}<span class="dim">{t("im Hintergrund: {id}", { id: c.bg })}</span>{/if}
      {#if open && c.path}<span class="dim ellipsis">in {shortPath(c.path)}</span>{/if}
    {/if}
    <span class="acts inline">
      {#if c.name !== "eval" && c.detail}<button class="act" title={t("Befehl kopieren")} onclick={(e) => { e.stopPropagation(); copy(c.detail ?? ""); }}>⧉ {t("Befehl")}</button>{/if}
      {#if c.out?.length}<button class="act" title={t("Ausgabe kopieren")} onclick={(e) => { e.stopPropagation(); copy((c.out ?? []).join("\n")); }}>⧉ {t("Ausgabe")}</button>{/if}
    </span>
  </div>
</div>

<style>
  .cmd { white-space: pre-wrap; word-break: break-all; color: var(--fg); }
  .frame.click:hover { border-color: color-mix(in srgb, var(--dim) 100%, transparent); }
  .frame:not(.click) pre { max-height: 60vh; overflow: auto; }
  .foot { gap: 10px; font-size: 11px; min-height: 20px; }
  .foot .acts { margin-left: auto; }
  .chip.bad { color: var(--red); background: color-mix(in srgb, var(--red) 16%, transparent); }
  .chip.good { color: var(--green); background: color-mix(in srgb, var(--green) 12%, transparent); }
</style>
