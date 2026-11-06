<script lang="ts">
  import StartView from "$lib/components/StartView.svelte";
  import { useWorkspaceStore } from "$lib/workspace";

  const store = useWorkspaceStore();
</script>

<StartView
  repositories={store.homeRepositories}
  loading={store.usesApplicationTabs ? !store.applicationReady : store.loading}
  error={store.startError}
  connectionError={store.connectionError}
  onChooseRepository={() => void store.chooseRepository()}
  onCreateRepository={() => void store.beginCreateRepository()}
  onRemoveRepository={(repositoryId) => void store.removeRepository(repositoryId)}
  canCreateRepository={store.selectedRepositoryActions.create.allowed}
  canOpenRepository={store.selectedRepositoryActions.open.allowed}
  canRemoveRepository={store.selectedRepositoryActions.remove.allowed}
  openUnavailableReason={store.selectedRepositoryActions.open.reason}
  createUnavailableReason={store.selectedRepositoryActions.create.reason}
  removeUnavailableReason={store.selectedRepositoryActions.remove.reason}
  onOpenRepository={(repositoryId) => void store.openRepository(repositoryId)}
  onRetryConnection={() => void store.retryLocalConnection()}
  groupedRepositories={store.usesApplicationTabs ? store.groupedHomeRepositories : undefined}
  onOpenScopedRepository={store.usesApplicationTabs ? (target) => void store.openScopedRepository(target) : undefined}
  onRemoveScopedRepository={store.usesApplicationTabs ? (target) => void store.removeScopedRepository(target) : undefined}
  environments={store.usesApplicationTabs ? store.operationEnvironments : undefined}
  environmentCatalogs={store.usesApplicationTabs ? store.homeEnvironmentCatalogs : undefined}
  onRetryEnvironmentCatalog={(id) => void store.retryEnvironmentCatalog(id)}
  onChooseRepositoryForEnvironment={store.usesApplicationTabs ? (id) => void store.chooseRepositoryForEnvironment(id) : undefined}
  onCreateRepositoryForEnvironment={store.usesApplicationTabs ? (id) => void store.beginCreateRepository(id) : undefined}
/>
