<script lang="ts">
  import type { WorkspaceStore } from "$lib/workspace/workspace-store.svelte";
  import WorkingTreePanel from "../WorkingTreePanel.svelte";
  import DiscardChangesDialog from "../DiscardChangesDialog.svelte";
  let { store }: { store: WorkspaceStore } = $props();
  const draft = { normal: { summary: "", description: "" }, amend: { summary: "", description: "" }, amendMode: false, amendHead: null };
</script>

{#if store.snapshot}
  <WorkingTreePanel snapshot={store.snapshot} {draft} amendInfo={null}
    onDraftChange={() => {}} onAmendToggle={() => {}} onDiscardPaths={(paths) => void store.openDiscard(paths)}
    selectedPaths={[]} selectedPathsSource={null} onSelectionPathsChange={() => {}} onSelectFile={() => {}}
    pending={store.gitActionPending} />
{/if}
<DiscardChangesDialog open={store.discardDialog !== null} files={store.discardDialog?.files ?? []}
  loading={store.discardDialog?.loading ?? false} error={store.discardDialog?.error ?? ""}
  onConfirm={(files, deleteUntracked) => store.confirmDiscard(files, deleteUntracked)} onCancel={() => store.discardDialog = null} />
