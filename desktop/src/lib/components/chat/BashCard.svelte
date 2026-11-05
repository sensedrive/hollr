<script lang="ts">
  import Icon from "$lib/components/git/Icon.svelte";
  // bash / eval: the command (with its folder like a prompt when it ran outside the space), the last 8 output lines
  // (click for everything the server sent), a footer with wall time and exit code, or the background job while it
  // runs; copy buttons for command and output. Clicking only toggles when nothing is selected.
  import type { ToolCall } from "../../api";
  import { duration, shortPath } from "../../agent";
  import { cwdShown, outTail, type JobView } from "../../chatTools";
  import { t } from "../../i18n";
  import Glyph from "./Glyph.svelte";
  import More from "./More.svelte";
  import { revealed } from "./reveal";

  let { c, root, tip, copy, job }: {
    c: ToolCall;
    root?: string;
    tip: string;
    copy: (s: string) => void;
    /** the background job this call started, while it still runs */
    job?: JobView;
  } = $props();

  const cwd = $derived(cwdShown(c.cwd, root, shortPath));
  // a running background job shows its run time – tick only while there is one
  let now = $state(Date.now());
  $effect(() => {
    if (!job) return;
    const id = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(id);
  });

  let own = $state(false);
  const reveal = revealed();
  /** clicked open, or opened by the find bar for a hit in the hidden output */
  const open = $derived(own || reveal.has(c.id));
  const tail = $derived(outTail(c, open));
  /** lines the server didn't send at all (it keeps the last 60) */
  const unsent = $derived(tail.earlier - tail.more);
  const toggle = () => {
    if (!window.getSelection()?.toString()) own = !open;
  };
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="frame {c.status}" class:click={!open} onclick={toggle} title={open ? tip : `${tip ? `${tip} · ` : ""}${t("Klicken für mehr Ausgabe")}`}>
  {#if c.name === "eval"}
    <div class="hrow"><Glyph status={c.status} ok="λ" color="var(--orange)" /> <b class="ellipsis">{c.detail ?? "Eval"}</b></div>
  {:else}
    <div class="cmd sel" class:clamp3={!open}>{#if cwd}<span class="cwd" title={c.cwd}>{cwd}</span>{" "}{/if}<span class="dim">{"$ "}</span>{c.detail ?? ""}</div>
  {/if}
  {#if tail.lines.length}
    <hr />
    <!-- the hidden lines are the earlier ones (output is a tail), so their switch sits on top like omp's -->
    {#if tail.more > 0 || (open && (c.out?.length ?? 0) > 8)}
      <More {open} hidden={tail.more} unit="earlier" ontoggle={() => (own = !open)} />
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
      {#if c.bg && job}
        <span class="braille acc"></span><span class="muted">{t("läuft im Hintergrund")}</span><span class="dim">{c.bg}{job.startedAt ? ` · ${duration(now - job.startedAt)}` : ""}</span>
      {:else if c.bg}<span class="dim">{t("im Hintergrund: {id}", { id: c.bg })}</span>{/if}
      {#if open && c.path}<span class="dim ellipsis">in {shortPath(c.path)}</span>{/if}
    {/if}
    <span class="acts inline">
      {#if c.name !== "eval" && c.detail}<button class="act" title={t("Befehl kopieren")} onclick={(e) => { e.stopPropagation(); copy(c.detail ?? ""); }}><Icon name="⧉" size={15} /> {t("Befehl")}</button>{/if}
      {#if c.out?.length}<button class="act" title={t("Ausgabe kopieren")} onclick={(e) => { e.stopPropagation(); copy((c.out ?? []).join("\n")); }}><Icon name="⧉" size={15} /> {t("Ausgabe")}</button>{/if}
    </span>
  </div>
</div>

<style>
  .cmd { white-space: pre-wrap; word-break: break-all; color: var(--fg); }
  /* the folder like a shell prompt: there, but quieter than the command */
  .cwd { color: color-mix(in srgb, var(--cyan) 70%, var(--dim)); }
  .frame.click:hover { border-color: color-mix(in srgb, var(--dim) 100%, transparent); }
  .frame:not(.click) pre { max-height: 60vh; overflow: auto; }
  .foot { gap: 10px; font-size: 11px; min-height: 20px; }
  .foot .acts { margin-left: auto; }
  .chip.bad { color: var(--red); background: color-mix(in srgb, var(--red) 16%, transparent); }
  .chip.good { color: var(--green); background: color-mix(in srgb, var(--green) 12%, transparent); }
</style>
