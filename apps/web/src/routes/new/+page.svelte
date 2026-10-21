<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import CreateRepositoryView, {
    type CreateRepositoryProvider,
  } from "$lib/components/CreateRepositoryView.svelte";
  import { useWorkspaceStore } from "$lib/workspace";

  const store = useWorkspaceStore();

  let provider = $state<CreateRepositoryProvider>("local");

  onMount(() => {
    // A direct visit to this page has no prepared form yet.
    if (!store.createRepositoryPrepared) {
      void store.prepareCreateRepository();
    }
  });

  onDestroy(() => {
    store.createRepositoryPrepared = false;
  });
</script>

<CreateRepositoryView
  {provider}
  parentPath={store.createRepositoryParentPath}
  name={store.createRepositoryName}
  initialBranch={store.createRepositoryInitialBranch}
  initializeLfs={store.createRepositoryInitializeLfs}
  error={store.createRepositoryError}
  loading={store.operationPending}
  canBrowse={store.isDesktop}
  onProviderChange={(value) => {
    provider = value;
    store.createRepositoryError = "";
  }}
  onParentPathChange={(value) => {
    store.createRepositoryParentPath = value;
    store.createRepositoryError = "";
  }}
  onNameChange={(value) => {
    store.createRepositoryName = value;
    store.createRepositoryError = "";
  }}
  onInitialBranchChange={(value) => {
    store.createRepositoryInitialBranch = value;
    store.createRepositoryError = "";
  }}
  onInitializeLfsChange={(value) => {
    store.createRepositoryInitializeLfs = value;
    store.createRepositoryError = "";
  }}
  onBrowse={() => void store.browseCreateRepositoryLocation()}
  onSubmit={() => void store.submitCreateRepository()}
  onCancel={() => void store.closeCreateRepositoryView()}
/>
