<script lang="ts">
  import { onMount } from "svelte";
  import { acquireDiffRenderer } from "$lib/diff/renderer";
  import StashDetailsPanel from "$lib/components/StashDetailsPanel.svelte";
  import StashReviewDialog from "$lib/components/StashReviewDialog.svelte";
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
  import type { RepositoryPageModel } from "$lib/workspace/repository-routing";

  let { store }: { store: RepositoryPageModel } = $props();

  onMount(() => {
    const renderer = acquireDiffRenderer();
    // A viewer reports initialization failures with Retry when opened.
    void renderer.ready.catch(() => {});
    return renderer.release;
  });

</script>

<div class={`grid h-full min-h-0 ${store.snapshot && store.repositoryDisconnected ? "grid-rows-[auto_minmax(0,1fr)]" : "grid-rows-[minmax(0,1fr)]"}`}>
{#if store.snapshot && store.repositoryDisconnected}
  <div role="status" class="flex items-center gap-3 border-b border-[var(--app-theme-border)] bg-[var(--app-theme-surface-raised)] px-3 py-1.5 text-xs text-[var(--app-theme-text)]">
    <span>{store.repositoryAvailability.environmentLabel}: {store.repositoryAvailability.title}. Showing saved data.</span>
    {#if store.repositoryAvailability.canRetry}
      <button type="button" class="rounded border border-[var(--app-theme-border)] px-2 py-1 hover:bg-[var(--app-theme-toolbar-control-hover)]" onclick={() => void store.retryActiveRepository()}>Retry</button>
    {/if}
  </div>
{/if}
<div class="min-h-0 overflow-hidden">
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
{:else if !store.snapshot}
  <div class="grid h-full min-h-0 place-items-center bg-[var(--app-theme-surface)] p-6 text-[var(--app-theme-text)]" role="status">
    <div class="max-w-md space-y-2 text-center">
      <p class="text-xs text-[var(--app-theme-text-muted)]">{store.repositoryAvailability.environmentLabel} · {store.activeRepository.title}</p>
      <p class="text-sm font-medium">{store.repositoryAvailability.title}</p>
      <p class="break-words text-xs text-[var(--app-theme-text-subtle)]">{store.repositoryAvailability.detail}</p>
      {#if store.repositoryAvailability.canRetry}
        <button type="button" class="mt-2 rounded border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-raised)] px-3 py-1.5 text-xs hover:bg-[var(--app-theme-toolbar-control-hover)]" onclick={() => void store.retryActiveRepository()}>Retry</button>
      {/if}
    </div>
  </div>
{:else if !store.largeScreen}
  <div class="compact-workspace grid h-full min-h-0 grid-cols-1 overflow-hidden">
    {#if store.snapshot && store.selectedFile && (store.selectedCommit || store.selectedStash || store.changesSelected)}
      <Sidebar
        repositoryEnvironments={store.activeRepositoryEnvironments}
        locationContext={store.activeApplicationTab}
        onSwitchLocation={(target, source) => void store.switchScopedRepository?.(target, source)}
        onOpenLocationInNewTab={(target, source) => void store.openScopedRepository?.(target, source)}
        stashContextKey={store.stashContextKey}
        stashCapabilities={store.stashCapabilities}
        onSelectStash={(stash) => store.selectStash(stash)}
        onStashAction={(action, stash) => store.openStashAction(action, stash)}
        onRenameWorktreeBranch={(worktree) => store.openRenameWorktreeBranchDialog(worktree)}
        snapshot={store.snapshot}
        selectedStash={store.selectedStash}
        selectedCommit={store.selectedCommit}
        stateKey={store.sidebarStateKey}
        visibleRefKeys={store.visibleGraphRefKeys}
        onSelectRef={(ref) => store.selectRef(ref)}
        canRenameBranch={store.canRenameBranch}
        canDeleteBranch={store.canDeleteBranch}
        canDeleteTag={store.canDeleteTag}
        canCheckoutTag={store.canCheckoutTag}
        canPushTag={store.canPushTag}
        onCheckoutTag={(tag) => store.checkoutTag(tag)}
        onPushTag={(tag) => store.pushTag(tag)}
        loadTagDetails={(tag) => store.loadTagDetails(tag)}
        onDeleteTag={(tag) => store.openDeleteTagDialog(tag)}
        canRemoveWorktree={store.canRemoveWorktree}
        onRemoveWorktree={(worktree, deleteBranch) => store.openRemoveWorktreeDialog(worktree, deleteBranch)}
        onRenameBranch={(ref) => store.openRenameBranchDialog(ref)}
        onDeleteBranch={(ref) => store.openDeleteBranchDialog(ref)}
        onSwitchBranch={(branchName) => store.switchBranch(branchName)}
        onSwitchWorktree={(path) => void store.switchWorktree(path)}
        onOpenWorktreeInNewTab={(path) => void store.openWorktreeInNewTab(path)}
        onToggleRefs={(refs, visible) => store.toggleGraphRefs(refs, visible)}
      />
      <div class="h-full min-h-0">
        <CommitFileDiffViewer
          client={store.client!} environmentGeneration={store.activeEnvironmentGeneration}
          repositoryId={store.activeRepositoryId!}
          snapshot={store.snapshot}
          diffSource={store.selectedStash ? "stash" : store.changesSelected ? store.selectedFileSource : (store.comparingCommitToWorkingTree ? "commitWorkingTree" : "commit")}
          selectedStash={store.selectedStash}
          selectedCommit={store.selectedCommit}
          selectedFile={store.selectedFile}
          contentRevision={store.workspaceState?.fileContentRevisions[store.activeRepositoryId!]?.[store.selectedFile.path] ?? 0}
          onClose={() => store.closeDiff()}
          onApplyHunks={(params) => store.applySelectedHunks(params)}
          pending={store.gitActionPending}
        />
      </div>
    {:else}
      <Sidebar
        repositoryEnvironments={store.activeRepositoryEnvironments}
        locationContext={store.activeApplicationTab}
        onSwitchLocation={(target, source) => void store.switchScopedRepository?.(target, source)}
        onOpenLocationInNewTab={(target, source) => void store.openScopedRepository?.(target, source)}
        stashContextKey={store.stashContextKey}
        stashCapabilities={store.stashCapabilities}
        onSelectStash={(stash) => store.selectStash(stash)}
        onStashAction={(action, stash) => store.openStashAction(action, stash)}
        onRenameWorktreeBranch={(worktree) => store.openRenameWorktreeBranchDialog(worktree)}
        snapshot={store.snapshot}
        selectedStash={store.selectedStash}
        selectedCommit={store.selectedCommit}
        stateKey={store.sidebarStateKey}
        visibleRefKeys={store.visibleGraphRefKeys}
        onSelectRef={(ref) => store.selectRef(ref)}
        canRenameBranch={store.canRenameBranch}
        canDeleteBranch={store.canDeleteBranch}
        canDeleteTag={store.canDeleteTag}
        canCheckoutTag={store.canCheckoutTag}
        canPushTag={store.canPushTag}
        onCheckoutTag={(tag) => store.checkoutTag(tag)}
        onPushTag={(tag) => store.pushTag(tag)}
        loadTagDetails={(tag) => store.loadTagDetails(tag)}
        onDeleteTag={(tag) => store.openDeleteTagDialog(tag)}
        canRemoveWorktree={store.canRemoveWorktree}
        onRemoveWorktree={(worktree, deleteBranch) => store.openRemoveWorktreeDialog(worktree, deleteBranch)}
        onRenameBranch={(ref) => store.openRenameBranchDialog(ref)}
        onDeleteBranch={(ref) => store.openDeleteBranchDialog(ref)}
        onSwitchWorktree={(path) => void store.switchWorktree(path)}
        onOpenWorktreeInNewTab={(path) => void store.openWorktreeInNewTab(path)}
        onToggleRefs={(refs, visible) => store.toggleGraphRefs(refs, visible)}
      />
      <div class="flex min-h-0 flex-col overflow-hidden">
        <HistoryToolbar
          canPop={store.canPopStash}
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
              stashCapabilities={store.stashCapabilities}
              onSelectStash={(stash) => store.selectStash(stash)}
              onStashAction={(action, stash) => store.openStashAction(action, stash)}
              contextKey={store.stashContextKey}
              snapshot={store.graphSnapshot}
              repositoryId={store.activeRepositoryId}
              getRestoredScrollTop={(repositoryId) => store.graphScrollTopFor(repositoryId)}
              selectedStash={store.selectedStash}
              selectedCommit={store.selectedCommit}
              changesSelected={store.changesSelected}
              scrollToCommit={store.scrollToCommit}
              onScrollTopChange={(repositoryId, scrollTop) => store.rememberGraphScrollTop(repositoryId, scrollTop)}
              onScrollCommandHandled={(commandId) => store.finishScrollToCommit(commandId)}
              onSelectChanges={() => store.selectChanges()}
              onSelectCommit={(commit) => store.selectCommit(commit)}
              onCompareCommitToWorkingTree={(commit) => store.compareCommitToWorkingTree(commit)}
              onCreateBranch={(commit) => store.openBranchDialog(commit)}
              onCreateTag={(commit) => store.openTagDialog(commit)}
              canCreateTag={store.canCreateTag}
              canRenameBranch={store.canRenameBranch}
              canDeleteBranch={store.canDeleteBranch}
              canRemoveWorktree={store.canRemoveWorktree}
              onRemoveWorktree={(worktree, deleteBranch) => store.openRemoveWorktreeDialog(worktree, deleteBranch)}
              onRenameBranch={(ref) => store.openRenameBranchDialog(ref)}
              onDeleteBranch={(ref) => store.openDeleteBranchDialog(ref)}
              pending={store.gitActionPending}
            />
          {/key}
        </div>
      </div>
    {/if}
    {#if store.snapshot && store.changesSelected}
      <WorkingTreePanel
        contextKey={store.stashContextKey}
        canStashSelected={store.stashCapabilities.selected}
        onStashSelected={(source, files) => store.openSelectedStash(source, files)}
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
    {:else if store.snapshot && store.selectedStash}
      <StashDetailsPanel client={store.client!} environmentGeneration={store.activeEnvironmentGeneration} repositoryId={store.activeRepositoryId!}
        stash={store.selectedStash} selectedFile={store.selectedFile} onSelectFile={(file) => store.selectFile(file)} />
    {:else if store.snapshot && store.selectedCommit}
      <CommitDetailsPanel
        client={store.client!} environmentGeneration={store.activeEnvironmentGeneration}
        repositoryId={store.activeRepositoryId!}
        snapshot={store.snapshot}
        selectedCommit={store.selectedCommit}
        comparisonWithWorkingTree={store.comparingCommitToWorkingTree}
        selectedFile={store.selectedFile}
        onSelectFile={(file) => store.selectFile(file, store.comparingCommitToWorkingTree ? "commitWorkingTree" : "workingTree")}
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
        {#if store.snapshot && store.selectedFile && (store.selectedCommit || store.selectedStash || store.changesSelected)}
          <CommitFileDiffViewer
            client={store.client!} environmentGeneration={store.activeEnvironmentGeneration}
            repositoryId={store.activeRepositoryId!}
            snapshot={store.snapshot}
            diffSource={store.selectedStash ? "stash" : store.changesSelected ? store.selectedFileSource : (store.comparingCommitToWorkingTree ? "commitWorkingTree" : "commit")}
            selectedStash={store.selectedStash}
            selectedCommit={store.selectedCommit}
            selectedFile={store.selectedFile}
            contentRevision={store.workspaceState?.fileContentRevisions[store.activeRepositoryId!]?.[store.selectedFile.path] ?? 0}
            onClose={() => store.closeDiff()}
            onApplyHunks={(params) => store.applySelectedHunks(params)}
            pending={store.gitActionPending}
          />
        {:else}
          <Sidebar
        repositoryEnvironments={store.activeRepositoryEnvironments}
        locationContext={store.activeApplicationTab}
        onSwitchLocation={(target, source) => void store.switchScopedRepository?.(target, source)}
        onOpenLocationInNewTab={(target, source) => void store.openScopedRepository?.(target, source)}
            stashContextKey={store.stashContextKey}
            stashCapabilities={store.stashCapabilities}
            onSelectStash={(stash) => store.selectStash(stash)}
            onStashAction={(action, stash) => store.openStashAction(action, stash)}
            onRenameWorktreeBranch={(worktree) => store.openRenameWorktreeBranchDialog(worktree)}
            snapshot={store.snapshot}
            selectedStash={store.selectedStash}
            selectedCommit={store.selectedCommit}
            stateKey={store.sidebarStateKey}
            visibleRefKeys={store.visibleGraphRefKeys}
            onSelectRef={(ref) => store.selectRef(ref)}
            canRenameBranch={store.canRenameBranch}
            canDeleteBranch={store.canDeleteBranch}
            canDeleteTag={store.canDeleteTag}
            canCheckoutTag={store.canCheckoutTag}
            canPushTag={store.canPushTag}
            onCheckoutTag={(tag) => store.checkoutTag(tag)}
            onPushTag={(tag) => store.pushTag(tag)}
            loadTagDetails={(tag) => store.loadTagDetails(tag)}
            onDeleteTag={(tag) => store.openDeleteTagDialog(tag)}
            canRemoveWorktree={store.canRemoveWorktree}
            onRemoveWorktree={(worktree, deleteBranch) => store.openRemoveWorktreeDialog(worktree, deleteBranch)}
            onRenameBranch={(ref) => store.openRenameBranchDialog(ref)}
            onDeleteBranch={(ref) => store.openDeleteBranchDialog(ref)}
            onSwitchBranch={(branchName) => store.switchBranch(branchName)}
            onSwitchWorktree={(path) => void store.switchWorktree(path)}
            onOpenWorktreeInNewTab={(path) => void store.openWorktreeInNewTab(path)}
            onToggleRefs={(refs, visible) => store.toggleGraphRefs(refs, visible)}
          />
        {/if}
      {/snippet}

      {#snippet pane1()}
        {#if store.snapshot && store.selectedFile && (store.selectedCommit || store.selectedStash || store.changesSelected)}
          <div class="h-full" aria-hidden="true"></div>
        {:else}
          <div class="flex h-full min-h-0 flex-col overflow-hidden">
            <HistoryToolbar
              canPop={store.canPopStash}
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
                  stashCapabilities={store.stashCapabilities}
                  onSelectStash={(stash) => store.selectStash(stash)}
                  onStashAction={(action, stash) => store.openStashAction(action, stash)}
                  contextKey={store.stashContextKey}
                  snapshot={store.graphSnapshot}
                  repositoryId={store.activeRepositoryId}
                  getRestoredScrollTop={(repositoryId) => store.graphScrollTopFor(repositoryId)}
                  selectedStash={store.selectedStash}
                  selectedCommit={store.selectedCommit}
                  changesSelected={store.changesSelected}
                  scrollToCommit={store.scrollToCommit}
                  onScrollTopChange={(repositoryId, scrollTop) => store.rememberGraphScrollTop(repositoryId, scrollTop)}
                  onScrollCommandHandled={(commandId) => store.finishScrollToCommit(commandId)}
                  onSelectChanges={() => store.selectChanges()}
                  onSelectCommit={(commit) => store.selectCommit(commit)}
                  onCompareCommitToWorkingTree={(commit) => store.compareCommitToWorkingTree(commit)}
                  onCreateBranch={(commit) => store.openBranchDialog(commit)}
                  onCreateTag={(commit) => store.openTagDialog(commit)}
                  canCreateTag={store.canCreateTag}
                  canRenameBranch={store.canRenameBranch}
                  canDeleteBranch={store.canDeleteBranch}
                  canRemoveWorktree={store.canRemoveWorktree}
                  onRemoveWorktree={(worktree, deleteBranch) => store.openRemoveWorktreeDialog(worktree, deleteBranch)}
                  onRenameBranch={(ref) => store.openRenameBranchDialog(ref)}
                  onDeleteBranch={(ref) => store.openDeleteBranchDialog(ref)}
                  pending={store.gitActionPending}
                />
              {/key}
            </div>
          </div>
        {/if}
      {/snippet}

      {#snippet pane2()}
        {#if store.snapshot && store.changesSelected}
          <WorkingTreePanel
            contextKey={store.stashContextKey}
            canStashSelected={store.stashCapabilities.selected}
            onStashSelected={(source, files) => store.openSelectedStash(source, files)}
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
        {:else if store.snapshot && store.selectedStash}
          <StashDetailsPanel client={store.client!} environmentGeneration={store.activeEnvironmentGeneration} repositoryId={store.activeRepositoryId!}
            stash={store.selectedStash} selectedFile={store.selectedFile} onSelectFile={(file) => store.selectFile(file)} />
        {:else if store.snapshot && store.selectedCommit}
          <CommitDetailsPanel
            client={store.client!} environmentGeneration={store.activeEnvironmentGeneration}
            repositoryId={store.activeRepositoryId!}
            snapshot={store.snapshot}
            selectedCommit={store.selectedCommit}
            comparisonWithWorkingTree={store.comparingCommitToWorkingTree}
            selectedFile={store.selectedFile}
            onSelectFile={(file) => store.selectFile(file, store.comparingCommitToWorkingTree ? "commitWorkingTree" : "workingTree")}
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
</div>
</div>

{#if store.stashReview}
  <StashReviewDialog review={store.stashReview} onSubmit={(value) => store.submitStashReview(value)} onCancel={() => store.stashReview = null} />
{/if}

<style>
  /* Keep navigation useful on small desktop windows instead of shrinking all
     three regions into shallow rows. Full desktop panes stay resizable. */
  @media (min-width: 768px) {
    .compact-workspace {
      grid-template-columns: 200px minmax(0, 1fr);
      grid-template-rows: minmax(0, 1fr) minmax(180px, 35%);
    }

    .compact-workspace > :global(:first-child) {
      grid-column: 1;
      grid-row: 1 / 3;
    }

    .compact-workspace > :global(:nth-child(2)) {
      grid-column: 2;
      grid-row: 1;
      min-width: 0;
    }

    .compact-workspace > :global(:nth-child(3)) {
      grid-column: 2;
      grid-row: 2;
      min-width: 0;
      border-top: 1px solid var(--app-theme-sidebar-border-subtle);
      border-left: 0;
    }
  }
</style>
