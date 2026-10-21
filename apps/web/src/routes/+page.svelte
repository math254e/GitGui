<script lang="ts">
  import StartView from "$lib/components/StartView.svelte";
  import { useWorkspaceStore } from "$lib/workspace";

  const store = useWorkspaceStore();
</script>

<StartView
  repositories={store.homeRepositories}
  loading={store.loading}
  error={store.startError}
  connectionError={store.connectionError}
  onChooseRepository={() => void store.chooseRepository()}
  onCreateRepository={() => void store.beginCreateRepository()}
  onRemoveRepository={(repositoryId) => void store.removeRepository(repositoryId)}
  canCreateRepository={store.isDesktop}
  onOpenRepository={(repositoryId) => void store.openRepository(repositoryId)}
  onRetryConnection={() => void store.retryLocalConnection()}
/>
