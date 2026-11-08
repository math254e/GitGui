<script lang="ts">
  let { action, id }: { action: "rename" | "delete"; id: string } = $props();
</script>

<p {id} class="mt-3 text-xs leading-5 text-[var(--app-theme-text-secondary)]">
  {#if action === "rename"}
    If another Git process changes this branch while renaming, the newer branch may be renamed instead.
  {:else}
    If another Git process changes or checks out this branch while deleting, a newer branch may be deleted or a worktree left without its branch.
  {/if}
  Avoid other Git operations on this repository until this action finishes.
</p>
