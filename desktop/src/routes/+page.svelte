<script lang="ts">
  // Hollr desktop: the app's shell.
  import "../app.css";
  import { appearance } from "$lib/appearance.svelte";
  import Shell from "$lib/views/Shell.svelte";

  appearance();
</script>

<Shell />
