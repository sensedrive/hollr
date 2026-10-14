<script lang="ts">
  let { page }: { page?: string } = $props();
</script>

<div class="page"><h1>Settings {page ?? ""}</h1></div>
