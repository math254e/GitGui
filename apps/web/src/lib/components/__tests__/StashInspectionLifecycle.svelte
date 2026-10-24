<script lang="ts">
  import type { WorkspaceStore } from "$lib/workspace/workspace-store.svelte";
  import StashDetailsPanel from "../StashDetailsPanel.svelte";
  import CommitFileDiffViewer from "../CommitFileDiffViewer.svelte";
  let { store }: { store: WorkspaceStore } = $props();
</script>

{#if store.selectedStash && store.client && store.snapshot}
  <StashDetailsPanel client={store.client} repositoryId={store.activeRepositoryId!} stash={store.selectedStash} selectedFile={store.selectedFile} onSelectFile={(file) => store.selectFile(file)} />
  {#if store.selectedFile}
    <CommitFileDiffViewer client={store.client} repositoryId={store.activeRepositoryId!} snapshot={store.snapshot} diffSource="stash" selectedCommit={null} selectedStash={store.selectedStash} selectedFile={store.selectedFile} onClose={() => store.closeDiff()} />
  {/if}
{/if}
