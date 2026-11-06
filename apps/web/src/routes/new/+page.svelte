<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import CreateRepositoryView, {
    type CreateRepositoryProvider,
  } from "$lib/components/CreateRepositoryView.svelte";
  import { useWorkspaceStore } from "$lib/workspace";

  const store = useWorkspaceStore();

  let provider = $state<CreateRepositoryProvider>("local");

  $effect(() => {
    // Cold routes mount before runtime registrations and tab metadata restore.
    // An explicitly prepared operation keeps its original environment.
    if (store.usesApplicationTabs && !store.applicationReady) return;
    if (!store.createRepositoryPrepared || (store.usesApplicationTabs && !store.createRepositoryEnvironmentId && store.environmentEntries.length > 0)) {
      untrack(() => { void store.prepareCreateRepository(); });
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
  loading={(store.usesApplicationTabs ? store.createRepositoryPending : store.operationPending) || !store.createRepositoryPrepared || store.createRepositoryPreparing || (store.usesApplicationTabs && !store.applicationReady)}
  canBrowse={store.usesApplicationTabs ? store.canBrowseCreateLocation : store.isDesktop}
  canCreate={store.createAvailability.allowed}
  unavailableReason={store.createAvailability.reason}
  environmentLabel={store.createEnvironmentLabel}
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
