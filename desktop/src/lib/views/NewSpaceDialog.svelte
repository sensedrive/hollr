<script lang="ts">
  import Modal from "$lib/components/Modal.svelte";
  let { preset, onClose }: { preset: { server?: string }; onClose: () => void } = $props();
</script>

<Modal title="Neuer Space" {onClose}><p class="dim">{preset.server ?? ""}</p></Modal>
