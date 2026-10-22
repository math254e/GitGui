<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { Toaster } from "svelte-sonner";
  import { provideWebApplicationRuntime } from "$lib/connection/runtime";
  import { provideWorkspaceStore } from "$lib/workspace";
  import {
    isSettingsRouteId,
    NEW_REPOSITORY_ROUTE_ID,
    REPOSITORY_ROUTE_ID,
  } from "$lib/workspace/routes";
  import DiscardChangesDialog from "$lib/components/DiscardChangesDialog.svelte";
  import DeleteBranchDialog from "$lib/components/DeleteBranchDialog.svelte";
  import RemoveWorktreeDialog from "$lib/components/RemoveWorktreeDialog.svelte";
  import GitActionStatusBar from "$lib/components/GitActionStatusBar.svelte";
  import GitNameDialog from "$lib/components/GitNameDialog.svelte";
  import RepositoryPathDialog from "$lib/components/RepositoryPathDialog.svelte";
  import TopMenu from "$lib/components/TopMenu.svelte";

  let { children } = $props();
  const runtime = provideWebApplicationRuntime();
  const store = provideWorkspaceStore(runtime);

  onMount(() => {
    void runtime.start();
    store.start();
  });

  onDestroy(() => {
    void runtime.stop();
    store.dispose();
  });

  // The route decides what the chrome shows. The store only supplies the
  // repository tabs and the current Git action. A repository route without a
  // repository is the repositories view, exactly as before.
  const activeView = $derived<"start" | "repo" | "settings" | "create">(
    store.currentRouteId === REPOSITORY_ROUTE_ID
      ? store.activeRepository
        ? "repo"
        : "start"
      : isSettingsRouteId(store.currentRouteId)
        ? "settings"
        : store.currentRouteId === NEW_REPOSITORY_ROUTE_ID
          ? "create"
          : "start",
  );

  const toastOptions = {
    unstyled: true,
    classes: {
      toast: "group relative flex w-fit min-w-[240px] max-w-[320px] items-center gap-3 rounded-lg border px-4 py-3 text-sm shadow-lg",
      title: "font-semibold text-[var(--app-theme-text)]",
      description: "text-xs text-[var(--app-theme-text-muted)]",
      content: "flex min-w-0 flex-1 flex-col gap-0.5",
      icon: "flex h-4 w-4 shrink-0 items-center justify-center",
      closeButton: "absolute -top-2 -left-2 z-10 inline-flex h-6 w-6 items-center justify-center rounded-full border border-[var(--app-theme-border)] bg-[var(--app-theme-surface)] text-[var(--app-theme-text-muted)] shadow-sm hover:bg-[var(--app-theme-sidebar-row-hover)]",
      success: "border-[var(--app-theme-accent)]/45 bg-[var(--app-theme-surface-raised)] text-[var(--app-theme-text)]",
      error: "border-[var(--app-theme-error)]/45 bg-[var(--app-theme-surface-raised)] text-[var(--app-theme-text)]",
    },
  };
</script>

<Toaster position="bottom-left" offset={{ bottom: "40px", left: "24px" }} closeButton toastOptions={toastOptions} />

<main class="grid h-screen min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] bg-[var(--app-theme-canvas)] text-[var(--app-theme-text)]">
  <TopMenu
    {activeView}
    activeRepoId={store.activeRepositoryId}
    tabs={store.repoTabs}
    onShowStart={() => void store.showStartView()}
    onShowSettings={() => void store.showSettingsView()}
    onSelectRepo={(repositoryId) => void store.selectRepository(repositoryId)}
    onCloseRepo={(repositoryId) => void store.closeRepository(repositoryId)}
  />

  <section class="min-h-0 overflow-hidden">
    {@render children()}
  </section>

  {#if activeView === "repo" && store.activeRepository}
    <GitActionStatusBar label={store.activeWorkingTreeAction?.label ?? null} />
  {/if}
</main>

<DiscardChangesDialog
  open={store.discardDialog !== null}
  files={store.discardDialog?.files ?? []}
  loading={store.discardDialog?.loading ?? false}
  error={store.discardDialog?.error ?? ""}
  onConfirm={(files, deleteUntracked) => store.confirmDiscard(files, deleteUntracked)}
  onCancel={() => { store.discardDialog = null; }}
/>

<RepositoryPathDialog
  open={store.repositoryPathDialogOpen}
  value={store.repositoryPathValue}
  error={store.repositoryPathError}
  loading={store.operationPending}
  onValueChange={(value) => {
    store.repositoryPathValue = value;
    store.repositoryPathError = "";
  }}
  onSubmit={() => void store.submitRepositoryPath()}
  onCancel={() => store.closeRepositoryPathDialog()}
/>

<GitNameDialog
  open={store.gitNameDialogKind !== null}
  kind={store.gitNameDialogKind ?? "branch"}
  value={store.gitNameDialogValue}
  loading={store.gitActionPending}
  error={store.gitNameDialogError}
  startPoint={store.gitNameDialogContext?.startPoint}
  checkout={store.gitNameDialogCheckout}
  onCheckoutChange={(checked) => { store.gitNameDialogCheckout = checked; }}
  onValueChange={(value) => {
    store.gitNameDialogValue = value;
    store.gitNameDialogError = "";
  }}
  onSubmit={() => store.submitGitNameDialog()}
  onCancel={() => store.closeGitNameDialog()}
/>

<DeleteBranchDialog
  open={store.deleteBranchDialog !== null}
  branchName={store.deleteBranchDialog?.branch.shortName ?? ""}
  force={store.deleteBranchDialog?.force ?? false}
  loading={store.gitActionPending}
  error={store.deleteBranchDialog?.error ?? ""}
  onConfirm={() => store.confirmDeleteBranch()}
  onCancel={() => { if (!store.gitActionPending) store.deleteBranchDialog = null; }}
/>

<RemoveWorktreeDialog
  open={store.removeWorktreeDialog !== null}
  path={store.removeWorktreeDialog?.worktree.path ?? ""}
  branch={store.removeWorktreeDialog?.worktree.branch ?? null}
  deleteBranch={store.removeWorktreeDialog?.deleteBranch ?? false}
  forceBranchDeletion={store.removeWorktreeDialog?.forceBranchDeletion ?? false}
  loading={store.gitActionPending}
  error={store.removeWorktreeDialog?.error ?? ""}
  onConfirm={() => store.confirmRemoveWorktree()}
  onCancel={() => { if (!store.gitActionPending) store.removeWorktreeDialog = null; }}
/>
