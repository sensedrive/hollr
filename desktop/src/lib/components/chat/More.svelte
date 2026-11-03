<script lang="ts">
  // The fold switch under a clipped list: "N weitere Zeilen" ↔ "weniger anzeigen".
  import { t } from "../../i18n";
  let { open, hidden, unit = "lines", ontoggle }: {
    open: boolean; hidden: number; unit?: "lines" | "earlier" | "files" | "links"; ontoggle: () => void;
  } = $props();
  const LABELS = {
    lines: "{n} weitere Zeilen",
    earlier: "{n} frühere Zeilen",
    files: "{n} weitere Einträge",
    links: "{n} weitere Links",
  };
  const label = $derived(open ? t("weniger anzeigen") : t(LABELS[unit], { n: hidden }));
</script>

<button class="more" onclick={(e) => { e.stopPropagation(); ontoggle(); }}>{open ? "▴" : "▾"} {label}</button>
