<script lang="ts">
  // The preview for a path the agent mentioned (⌘-click in the terminal, click in the chat): the server resolves it
  // (`hollr gate file`, relative paths from the pane's folder) and this shows images (fit or 100 %, drag to pan),
  // text and code with the `:line` in view (FileViewer), folders as a list to walk, refusals in words. Esc closes.
  import { onMount } from "svelte";
  import * as api from "../api";
  import * as git from "../git";
  import { t } from "../i18n";
  import { copy } from "../serverapi";
  import FileGlyph from "./git/FileGlyph.svelte";
  import FileViewer from "./git/FileViewer.svelte";
  import Icon from "./git/Icon.svelte";

  let { server, pane, path, line, onClose, onGit }: {
    server: string;
    /** relative paths resolve from this pane's folder */
    pane: string;
    path: string;
    line?: number;
    onClose: () => void;
    /** "Im Git-Panel öffnen": the path relative to the space root, and whether it is a folder */
    onGit?: (rel: string, dir: boolean) => void;
  } = $props();

  // folders opened from here stack up; ← goes back
  // svelte-ignore state_referenced_locally
  let stack = $state<{ path: string; line?: number }[]>([{ path, line }]);
  const cur = $derived(stack[stack.length - 1] ?? { path });
  let info = $state<api.FileInfo | null>(null);
  let error = $state("");
  let zoom = $state<"fit" | "full">("fit");
  let natural = $state<{ w: number; h: number } | null>(null);
  let copied = $state<"" | "path" | "content">("");
  let copyError = $state("");
  let dialog: HTMLDivElement | undefined = $state();
  let img: HTMLImageElement | undefined = $state();
  let imgBox: HTMLDivElement | undefined = $state();

  function errorText(e: unknown): string {
    const code = e instanceof Error ? e.message : String(e);
    const known: Record<string, string> = {
      not_found: t("Nicht gefunden – weder im Ordner der Session noch im Space."),
      outside: t("Nicht erlaubt: Hollr zeigt nur Dateien in deinem Home-Ordner und in /tmp."),
      secret: t("Nicht erlaubt: Schlüssel, Zugangsdaten und .env-Dateien zeigt Hollr nicht an."),
      unreadable: t("Die Datei lässt sich nicht lesen (keine Berechtigung?)."),
      not_allowed: t("Hollr auf dem Server ist zu alt – unter Server › Werkzeuge aktualisieren."),
    };
    return known[code] ?? code;
  }

  let seq = 0;
  $effect(() => {
    const p = cur.path;
    const n = ++seq;
    info = null;
    error = "";
    natural = null;
    zoom = "fit";
    api.file(server, pane, p).then(
      (r) => { if (n === seq) info = r; },
      (e) => { if (n === seq) error = errorText(e); },
    );
  });

  onMount(() => dialog?.focus());

  const open = (p: string) => (stack = [...stack, { path: p }]);
  const back = () => (stack = stack.slice(0, -1));
  const join = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);
  const parent = $derived(info?.kind === "dir" && info.path !== "/" ? info.path.split("/").slice(0, -1).join("/") || "/" : "");
  const src = $derived(info?.kind === "image" && info.data ? `data:${info.mime};base64,${info.data}` : "");
  const shownPath = $derived(info?.path ?? cur.path);

  function flash(what: "path" | "content") {
    copied = what;
    copyError = "";
    setTimeout(() => { if (copied === what) copied = ""; }, 1400);
  }
  async function copyPath() {
    if (await copy(shownPath)) flash("path");
  }
  /** the image as PNG – the one image type every clipboard takes */
  async function pngBlob(): Promise<Blob> {
    if (info?.mime === "image/png") return (await fetch(src)).blob();
    const el = img;
    if (!el) throw new Error("no image");
    const canvas = document.createElement("canvas");
    canvas.width = el.naturalWidth;
    canvas.height = el.naturalHeight;
    canvas.getContext("2d")?.drawImage(el, 0, 0);
    return new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("no png"))), "image/png"));
  }
  async function copyContent() {
    if (!info) return;
    try {
      if (info.kind === "image") {
        // the item takes a promise: WebKit wants clipboard.write called right in the click
        await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob() })]);
      } else if (!(await copy(info.text ?? ""))) throw new Error("copy");
      flash("content");
    } catch (e) {
      copyError = t("Kopieren ging nicht: {e}", { e: e instanceof Error ? e.message : String(e) });
    }
  }

  // 100 %: drag to pan (a click without moving switches back to fit)
  function pointerDown(e: PointerEvent) {
    if (e.button !== 0 || !imgBox) return;
    const box = imgBox;
    const start = { x: e.clientX, y: e.clientY, left: box.scrollLeft, top: box.scrollTop };
    let moved = false;
    const move = (m: PointerEvent) => {
      const dx = m.clientX - start.x;
      const dy = m.clientY - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      if (zoom === "full") {
        box.scrollLeft = start.left - dx;
        box.scrollTop = start.top - dy;
      }
    };
    const up = (u: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!moved) toggleZoom(u);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    e.preventDefault();
  }
  /** to 100 % around the clicked point, or back to fit */
  function toggleZoom(e?: { clientX: number; clientY: number }) {
    if (!imgBox || !img) return;
    if (zoom === "full") { zoom = "fit"; return; }
    const r = img.getBoundingClientRect();
    const fx = e && r.width ? (e.clientX - r.left) / r.width : 0.5;
    const fy = e && r.height ? (e.clientY - r.top) / r.height : 0.5;
    zoom = "full";
    const box = imgBox;
    requestAnimationFrame(() => {
      box.scrollLeft = fx * box.scrollWidth - box.clientWidth / 2;
      box.scrollTop = fy * box.scrollHeight - box.clientHeight / 2;
    });
  }

  // on the window: a clicked folder row re-renders away and takes the focus with it
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Backspace" && stack.length > 1 && (e.target as HTMLElement).tagName !== "INPUT") {
      e.preventDefault();
      back();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onclick={(e) => e.target === e.currentTarget && onClose()}>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="preview" role="dialog" aria-label={info?.name ?? cur.path} tabindex="-1" bind:this={dialog}>
    <header>
      {#if stack.length > 1}
        <button class="ib" onclick={back} title={t("Zurück")} aria-label={t("Zurück")}><Icon name="back" size={15} /></button>
      {/if}
      <div class="who">
        <div class="name">{info?.name ?? cur.path.split("/").filter(Boolean).pop() ?? cur.path}</div>
        <div class="path mono" title={shownPath}><bdi>{shownPath}{cur.line ? `:${cur.line}` : ""}</bdi></div>
      </div>
      {#if info}
        <span class="meta">{[
          info.kind === "dir" ? "" : git.bytes(info.size),
          natural ? `${natural.w} × ${natural.h}` : "",
          info.mtime ? git.relative(info.mtime) : "",
        ].filter(Boolean).join(" · ")}</span>
      {/if}
      <span class="tools">
        {#if info?.kind === "image" && src}
          <button class="tb" class:on={zoom === "full"} onclick={() => toggleZoom()} title={t("Einpassen / 100 %")}>
            {zoom === "fit" ? t("Einpassen") : "100 %"}</button>
        {/if}
        <button class="tb" onclick={copyPath}><Icon name={copied === "path" ? "check" : "copy"} size={14} /><span>{t("Pfad kopieren")}</span></button>
        {#if (info?.kind === "image" && src) || info?.kind === "text"}
          <button class="tb" onclick={copyContent}>
            <Icon name={copied === "content" ? "check" : "copy"} size={14} /><span>{info.kind === "image" ? t("Bild kopieren") : t("Text kopieren")}</span>
          </button>
        {/if}
        {#if info && info.inSpace !== undefined && onGit}
          {@const rel = info.inSpace}
          {@const dir = info.kind === "dir"}
          <button class="tb" onclick={() => onGit(rel, dir)}><Icon name="branch" size={14} /><span>{t("Im Git-Panel öffnen")}</span></button>
        {/if}
        <button class="ib" onclick={onClose} title={`${t("Schließen")} (Esc)`} aria-label={t("Schließen")}><Icon name="x" size={15} /></button>
      </span>
    </header>
    {#if copyError}<div class="copyerr">{copyError}</div>{/if}

    <div class="body">
      {#if error}
        <div class="empty"><Icon name="x" size={22} /><b>{t("Kann nicht geöffnet werden")}</b><span class="err">{error}</span></div>
      {:else if !info}
        <div class="empty dim">{t("Lädt …")}</div>
      {:else if info.kind === "image"}
        {#if src}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="imgbox" class:full={zoom === "full"} bind:this={imgBox} onpointerdown={pointerDown}>
            <img bind:this={img} {src} alt={info.name} draggable="false"
              onload={() => img && (natural = { w: img.naturalWidth, h: img.naturalHeight })} />
          </div>
        {:else}
          <div class="empty"><Icon name="doc" size={26} /><b>{t("Zu groß für die Vorschau")}</b>
            <span class="dim">{t("{size} – Bilder bis 15 MB", { size: git.bytes(info.size) })}</span></div>
        {/if}
      {:else if info.kind === "text"}
        <FileViewer {server} ws="" path={info.path} line={cur.line}
          loaded={{ path: info.path, size: info.size, binary: false, truncated: info.truncated, text: info.text ?? "" }} />
      {:else if info.kind === "dir"}
        {@const dir = info.path}
        <div class="list">
          {#if parent}
            <button class="item" onclick={() => open(parent)}><Icon name="up" size={15} /><span class="nm dim">..</span></button>
          {/if}
          {#each info.entries ?? [] as e (e.name)}
            <button class="item" onclick={() => open(join(dir, e.name))} title={join(dir, e.name)}>
              <FileGlyph name={e.name} dir={e.dir} /><span class="nm">{e.name}</span>
              {#if !e.dir}<span class="sz dim">{git.bytes(e.size)}</span>{/if}
            </button>
          {:else}
            <div class="empty dim">{t("Leerer Ordner")}</div>
          {/each}
          {#if info.truncated}<div class="more dim">{t("… weitere Einträge nicht gezeigt")}</div>{/if}
        </div>
      {:else}
        <div class="empty"><Icon name="doc" size={26} /><b>{t("Binärdatei")}</b>
          <span class="dim">{info.mime} · {git.bytes(info.size)}</span></div>
      {/if}
    </div>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); display: grid; place-items: center; z-index: 10; }
  .preview { background: var(--bg); border: 1px solid var(--border); border-radius: 14px; width: min(1100px, 94vw); height: 86vh;
    display: flex; flex-direction: column; overflow: hidden; outline: none; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4); }
  header { display: flex; align-items: center; gap: 10px; padding: 10px 12px 10px 16px; border-bottom: 1px solid var(--border); min-width: 0; }
  .who { min-width: 0; flex: 1; }
  .name { font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .path { font-size: 11.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; }
  .meta { font-size: 11.5px; color: var(--dim); white-space: nowrap; }
  .tools { display: flex; gap: 4px; align-items: center; flex: none; }
  .tb { display: inline-flex; align-items: center; gap: 6px; background: none; border: 1px solid transparent; border-radius: 7px; padding: 4px 8px;
    color: var(--muted); font-size: 12px; white-space: nowrap; }
  .tb:hover { border-color: var(--border); color: var(--fg); }
  .tb.on { background: var(--card); border-color: var(--border); color: var(--fg); }
  .ib { all: unset; cursor: pointer; width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px; color: var(--muted); }
  .ib:hover { background: var(--card); color: var(--fg); }
  .copyerr { padding: 6px 16px; font-size: 12px; color: var(--red); border-bottom: 1px solid var(--border); }
  .body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
  .empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 60px 20px; color: var(--muted); text-align: center; }
  .empty b { color: var(--fg); font-size: 15px; }
  .err { color: var(--red); max-width: 520px; }
  .imgbox { flex: 1; min-height: 0; display: grid; place-items: center; overflow: hidden; padding: 12px; cursor: zoom-in;
    background: repeating-conic-gradient(color-mix(in srgb, var(--fg) 6%, transparent) 0 25%, transparent 0 50%) 0 0 / 16px 16px; }
  .imgbox img { max-width: 100%; max-height: 100%; object-fit: contain; user-select: none; }
  .imgbox.full { display: block; overflow: auto; cursor: grab; padding: 0; }
  .imgbox.full:active { cursor: grabbing; }
  .imgbox.full img { max-width: none; max-height: none; display: block; margin: auto; }
  .list { overflow: auto; padding: 6px 0; }
  .item { all: unset; box-sizing: border-box; cursor: pointer; display: flex; align-items: center; gap: 10px; width: 100%; padding: 5px 16px; font-size: 13px; }
  .item:hover, .item:focus-visible { background: color-mix(in srgb, var(--fg) 6%, transparent); }
  .nm { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sz { font-size: 11.5px; }
  .more { padding: 8px 16px; font-size: 12px; }
  .dim { color: var(--dim); }
  .mono { font-family: var(--mono); }
</style>
