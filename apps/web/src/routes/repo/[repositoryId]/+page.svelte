<script lang="ts">
  import { page } from "$app/state";
  import CommitDetailsPanel from "$lib/components/CommitDetailsPanel.svelte";
  import CommitFileDiffViewer from "$lib/components/CommitFileDiffViewer.svelte";
  import EmptyDetailsPanel from "$lib/components/EmptyDetailsPanel.svelte";
  import GitGraph from "$lib/components/GitGraph.svelte";
  import HistoryToolbar from "$lib/components/HistoryToolbar.svelte";
  import RepositoryDetailsPanel from "$lib/components/RepositoryDetailsPanel.svelte";
  import ResizablePaneGroup from "$lib/components/ResizablePaneGroup.svelte";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import StartView from "$lib/components/StartView.svelte";
  import WorkingTreePanel from "$lib/components/WorkingTreePanel.svelte";
  import { useWorkspaceStore } from "$lib/workspace";
  import { resolveRouteIntent } from "$lib/workspace/repository-routing";
  import { repositoryIdFromParam } from "$lib/workspace/routes";

  const store = useWorkspaceStore();

  const routedRepositoryId = $derived(repositoryIdFromParam(page.params.repositoryId));

  // The URL selects the repository. The effect resolves that selection once
  // per route entry, so closing a tab never makes this page reopen it.
  let handledRepositoryId: string | null = null;

  $effect(() => {
    const repositoryId = routedRepositoryId;
    const workspace = store.workspace;
    if (!workspace) return;
    if (repositoryId === handledRepositoryId) return;
    handledRepositoryId = repositoryId;

    const intent = resolveRouteIntent({
      routedRepositoryId: repositoryId,
      openRepositoryIds: store.openRepos.map((repo) => repo.id),
      activeRepositoryId: store.activeRepositoryId,
    });

    if (intent.kind === "select") {
      void store.selectRepository(intent.repositoryId);
      return;
    }

    if (intent.kind === "open") {
      void store.openRepository(intent.repositoryId).then((opened) => {
        if (!opened && routedRepositoryId === intent.repositoryId) {
          void store.showStartView();
        }
      });
    }
  });
</script>

{#if !store.activeRepository}
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
{:else if !store.largeScreen}
  <div class="grid h-full min-h-0 grid-cols-1 overflow-hidden">
    {#if store.snapshot && store.selectedFile && (store.selectedCommit || store.changesSelected)}
      <Sidebar
        snapshot={store.snapshot}
        selectedCommit={store.selectedCommit}
        stateKey={store.sidebarStateKey}
        visibleRefKeys={store.visibleGraphRefKeys}
        onSelectRef={(ref) => store.selectRef(ref)}
        onSwitchBranch={(branchName) => store.switchBranch(branchName)}
        onSwitchWorktree={(path) => void store.switchWorktree(path)}
        onToggleRefs={(refs, visible) => store.toggleGraphRefs(refs, visible)}
      />
      <div class="h-full min-h-0">
        <CommitFileDiffViewer
          client={store.client!}
          repositoryId={store.activeRepositoryId!}
          snapshot={store.snapshot}
          diffSource={store.changesSelected ? store.selectedFileSource : "commit"}
          selectedCommit={store.selectedCommit}
          selectedFile={store.selectedFile}
          onClose={() => store.closeDiff()}
          onApplyHunks={(params) => store.applySelectedHunks(params)}
          pending={store.gitActionPending}
        />
      </div>
    {:else}
      <Sidebar
        snapshot={store.snapshot}
        selectedCommit={store.selectedCommit}
        stateKey={store.sidebarStateKey}
        visibleRefKeys={store.visibleGraphRefKeys}
        onSelectRef={(ref) => store.selectRef(ref)}
        onSwitchWorktree={(path) => void store.switchWorktree(path)}
        onToggleRefs={(refs, visible) => store.toggleGraphRefs(refs, visible)}
      />
      <div class="flex min-h-0 flex-col overflow-hidden">
        <HistoryToolbar
          onFetch={() => store.fetchRepository()}
          onPull={() => store.pullRepository()}
          onPush={() => store.pushRepository()}
          onBranch={() => store.openBranchDialog()}
          onStash={() => store.openStashDialog()}
          onPop={() => store.popStash()}
          pending={store.gitActionPending}
          pendingKind={store.gitAction?.kind ?? null}
        />
        <div class="min-h-0 flex-1">
          {#key store.activeRepositoryId}
            <GitGraph
              snapshot={store.graphSnapshot}
              repositoryId={store.activeRepositoryId}
              getRestoredScrollTop={(repositoryId) => store.graphScrollTopFor(repositoryId)}
              selectedCommit={store.selectedCommit}
              changesSelected={store.changesSelected}
              scrollToCommit={store.scrollToCommit}
              onScrollTopChange={(repositoryId, scrollTop) => store.rememberGraphScrollTop(repositoryId, scrollTop)}
              onScrollCommandHandled={(commandId) => store.finishScrollToCommit(commandId)}
              onSelectChanges={() => store.selectChanges()}
              onSelectCommit={(commit) => store.selectCommit(commit)}
            />
          {/key}
        </div>
      </div>
    {/if}
    {#if store.snapshot && store.changesSelected}
      <WorkingTreePanel
        snapshot={store.snapshot}
        selectedPaths={store.selectedChangePaths}
        selectedPathsSource={store.selectedChangeSource}
        onSelectionPathsChange={(paths, source) => store.selectChangePaths(paths, source)}
        onSelectFile={(file, source) => store.selectFile(file, source)}
        onStageFile={(file) => store.stageFile(file)}
        onStagePaths={(paths) => store.stagePaths(paths)}
        onUnstageFile={(file) => store.unstageFile(file)}
        onUnstagePaths={(paths) => store.unstagePaths(paths)}
        onStageAll={() => store.stageAll()}
        onUnstageAll={() => store.unstageAll()}
        onCommit={(draft) => store.commitChanges(draft)}
        draft={store.activeCommitDraft}
        amendInfo={store.amendInfo}
        amendLoading={store.amendLoading}
        onDraftChange={(draft) => store.changeCommitDraft(draft)}
        onAmendToggle={(enabled) => store.toggleAmend(enabled)}
        onDiscardPaths={(paths) => void store.openDiscard(paths)}
        disabled={store.gitActionPending}
        pending={store.gitActionPending}
        commitPending={store.commitPending}
        stageActionRunning={store.stageActionRunning}
        stageQueueWaiting={store.stageQueueWaiting}
        stageQueueLabel={store.stageQueueLabel}
      />
    {:else if store.snapshot && store.selectedCommit}
      <CommitDetailsPanel
        client={store.client!}
        repositoryId={store.activeRepositoryId!}
        snapshot={store.snapshot}
        selectedCommit={store.selectedCommit}
        selectedFile={store.selectedFile}
        onSelectFile={(file) => store.selectFile(file)}
      />
    {:else if store.snapshot}
      <RepositoryDetailsPanel snapshot={store.snapshot} />
    {:else}
      <EmptyDetailsPanel />
    {/if}
  </div>
{:else}
  <div class="h-full min-h-0">
    <ResizablePaneGroup panes={store.largeScreenPanes} onResize={(id, width) => store.resizePane(id, width)}>
      {#snippet pane0()}
        {#if store.snapshot && store.selectedFile && (store.selectedCommit || store.changesSelected)}
          <CommitFileDiffViewer
            client={store.client!}
            repositoryId={store.activeRepositoryId!}
            snapshot={store.snapshot}
            diffSource={store.changesSelected ? store.selectedFileSource : "commit"}
            selectedCommit={store.selectedCommit}
            selectedFile={store.selectedFile}
            onClose={() => store.closeDiff()}
            onApplyHunks={(params) => store.applySelectedHunks(params)}
            pending={store.gitActionPending}
          />
        {:else}
          <Sidebar
            snapshot={store.snapshot}
            selectedCommit={store.selectedCommit}
            stateKey={store.sidebarStateKey}
            visibleRefKeys={store.visibleGraphRefKeys}
            onSelectRef={(ref) => store.selectRef(ref)}
            onSwitchBranch={(branchName) => store.switchBranch(branchName)}
            onSwitchWorktree={(path) => void store.switchWorktree(path)}
            onToggleRefs={(refs, visible) => store.toggleGraphRefs(refs, visible)}
          />
        {/if}
      {/snippet}

      {#snippet pane1()}
        {#if store.snapshot && store.selectedFile && (store.selectedCommit || store.changesSelected)}
          <div class="h-full" aria-hidden="true"></div>
        {:else}
          <div class="flex h-full min-h-0 flex-col overflow-hidden">
            <HistoryToolbar
              onFetch={() => store.fetchRepository()}
              onPull={() => store.pullRepository()}
              onPush={() => store.pushRepository()}
              onBranch={() => store.openBranchDialog()}
              onStash={() => store.openStashDialog()}
              onPop={() => store.popStash()}
              pending={store.gitActionPending}
              pendingKind={store.gitAction?.kind ?? null}
            />
            <div class="min-h-0 flex-1">
              {#key store.activeRepositoryId}
                <GitGraph
                  snapshot={store.graphSnapshot}
                  repositoryId={store.activeRepositoryId}
                  getRestoredScrollTop={(repositoryId) => store.graphScrollTopFor(repositoryId)}
                  selectedCommit={store.selectedCommit}
                  changesSelected={store.changesSelected}
                  scrollToCommit={store.scrollToCommit}
                  onScrollTopChange={(repositoryId, scrollTop) => store.rememberGraphScrollTop(repositoryId, scrollTop)}
                  onScrollCommandHandled={(commandId) => store.finishScrollToCommit(commandId)}
                  onSelectChanges={() => store.selectChanges()}
                  onSelectCommit={(commit) => store.selectCommit(commit)}
                />
              {/key}
            </div>
          </div>
        {/if}
      {/snippet}

      {#snippet pane2()}
        {#if store.snapshot && store.changesSelected}
          <WorkingTreePanel
            snapshot={store.snapshot}
            selectedPaths={store.selectedChangePaths}
            selectedPathsSource={store.selectedChangeSource}
            onSelectionPathsChange={(paths, source) => store.selectChangePaths(paths, source)}
            onSelectFile={(file, source) => store.selectFile(file, source)}
            onStageFile={(file) => store.stageFile(file)}
            onStagePaths={(paths) => store.stagePaths(paths)}
            onUnstageFile={(file) => store.unstageFile(file)}
            onUnstagePaths={(paths) => store.unstagePaths(paths)}
            onStageAll={() => store.stageAll()}
            onUnstageAll={() => store.unstageAll()}
            onCommit={(draft) => store.commitChanges(draft)}
            draft={store.activeCommitDraft}
            amendInfo={store.amendInfo}
            amendLoading={store.amendLoading}
            onDraftChange={(draft) => store.changeCommitDraft(draft)}
            onAmendToggle={(enabled) => store.toggleAmend(enabled)}
            onDiscardPaths={(paths) => void store.openDiscard(paths)}
            disabled={store.gitActionPending}
            pending={store.gitActionPending}
            commitPending={store.commitPending}
            stageActionRunning={store.stageActionRunning}
            stageQueueWaiting={store.stageQueueWaiting}
            stageQueueLabel={store.stageQueueLabel}
          />
        {:else if store.snapshot && store.selectedCommit}
          <CommitDetailsPanel
            client={store.client!}
            repositoryId={store.activeRepositoryId!}
            snapshot={store.snapshot}
            selectedCommit={store.selectedCommit}
            selectedFile={store.selectedFile}
            onSelectFile={(file) => store.selectFile(file)}
          />
        {:else if store.snapshot}
          <RepositoryDetailsPanel snapshot={store.snapshot} />
        {:else}
          <EmptyDetailsPanel />
        {/if}
      {/snippet}
    </ResizablePaneGroup>
  </div>
{/if}
