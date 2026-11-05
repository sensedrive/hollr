<script lang="ts">
  // Line icons for the whole app (stroke = currentColor). The git views' set is drawn on a 16px grid, the app-wide
  // set (sidebar, tabs, chat, palette) on Lucide's 24px grid – both render at the same stroke weight.
  let { name, size = 16 }: { name: string; size?: number } = $props();
  const paths24: Record<string, string> = {
    grid: "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z",
    find: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
    sliders: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
    globe: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20",
    info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01",
    maximize: "M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3",
    more: "M5 12h.01M12 12h.01M19 12h.01",
    terminal: "M4 17l6-6-6-6M12 19h8",
    server: "M4 3h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM4 13h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2zM6 7h.01M6 17h.01",
    offline: "M2 2l20 20M8.5 16.4a5 5 0 0 1 7 0M2 8.8a15 15 0 0 1 4.2-2.8M10.7 5.1A15 15 0 0 1 22 8.8M5 12.9a10 10 0 0 1 5.2-2.8M19 12.9a10 10 0 0 0-2.4-1.7M12 20h.01",
    corner: "M15 10l5 5-5 5M4 4v7a4 4 0 0 0 4 4h12",
    list: "M3 5h.01M3 12h.01M3 19h.01M8 5h13M8 12h13M8 19h13",
    space: "M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z",
  };
  const big = $derived(name in paths24);
  const paths: Record<string, string> = {
    files: "M3 3.5h4M3 8h10M3 12.5h10M6 5.75h7",
    changes: "M4 2.5h5.5L12.5 5.5V13.5H4zM9.5 2.5v3h3M8.25 7.25v4M6.25 9.25h4",
    history: "M2.75 8a5.25 5.25 0 1 0 1.6-3.8M2.5 2.75v2.5H5M8 5.25V8l2 1.5",
    branch: "M5 2.75v10.5M5 12a1.25 1.25 0 1 0 0 2.5A1.25 1.25 0 0 0 5 12zM11 4.75a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5zM11 4.75c0 3-6 2.5-6 5.75",
    folder: "M2 4.25c0-.7.55-1.25 1.25-1.25h3l1.5 1.75h5c.7 0 1.25.55 1.25 1.25v6c0 .7-.55 1.25-1.25 1.25h-9.5C2.55 13.25 2 12.7 2 12z",
    reload: "M13.25 8a5.25 5.25 0 1 1-1.55-3.7M13.5 2.5v2.75h-2.75",
    back: "M10 3.5 5.5 8l4.5 4.5",
    chevronR: "M6 3.5 10.5 8 6 12.5",
    chevronD: "M3.5 6 8 10.5 12.5 6",
    pr: "M4.5 2.75v10.5M4.5 12a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5zM4.5 2a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5zM11.5 12a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5zM11.5 12V6.5c0-1.1-.9-2-2-2H7.5M9 3 7.5 4.5 9 6",
    check: "M3.5 8.5 6.5 11.5 12.5 4.5",
    x: "M4 4l8 8M12 4l-8 8",
    clock: "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 5v3l2 1.5",
    copy: "M5.5 5.5h7v7.5h-7zM3.5 10.5V3h7",
    wrap: "M2.5 4h11M2.5 8h9a2 2 0 0 1 0 4H8.5M10 10.5 8.5 12 10 13.5M2.5 12h3.5",
    split: "M2.5 3h11v10h-11zM8 3v10",
    unified: "M2.5 3h11v10h-11zM2.5 8h11",
    panelLeft: "M2.5 3h11v10h-11zM6 3v10M3.75 5.5h1M3.75 7.5h1",
    panelTop: "M2.5 3h11v10h-11zM2.5 6.5h11M4.5 4.75h3",
    plus: "M8 3.5v9M3.5 8h9",
    minus: "M3.5 8h9",
    expand: "M8 2.5v11M5.5 5 8 2.5 10.5 5M5.5 11 8 13.5 10.5 11",
    search: "M7 2.75a4.25 4.25 0 1 0 0 8.5 4.25 4.25 0 0 0 0-8.5zM10.25 10.25 13.5 13.5",
    commit: "M8 5.75a2.25 2.25 0 1 0 0 4.5 2.25 2.25 0 0 0 0-4.5zM1.5 8h4.25M10.25 8h4.25",
    tag: "M2.5 2.5h5l6 6-5 5-6-6zM5.25 5.25h.01",
    doc: "M4 2.5h5.5L12.5 5.5V13.5H4zM9.5 2.5v3h3",
    eye: "M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8zM8 6.25a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5z",
    code: "M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5",
    discard: "M3.5 6.5h6.25a3.25 3.25 0 0 1 0 6.5H7M6 4 3.5 6.5 6 9",
    comment: "M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z",
    paperclip: "M13 7.5 8 12.5a3.2 3.2 0 0 1-4.5-4.5l5.25-5.25a2.1 2.1 0 0 1 3 3L6.5 11a1 1 0 0 1-1.5-1.5L9.75 4.75",
    up: "M8 13V3M4 7l4-4 4 4",
  };
</script>

<svg class="icon" width={size} height={size} viewBox={big ? "0 0 24 24" : "0 0 16 16"} fill="none" stroke="currentColor"
  stroke-width={big ? 2 : 1.4} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={big ? paths24[name] : (paths[name] ?? "")} /></svg>

<style>
  .icon { flex: none; display: block; }
</style>
