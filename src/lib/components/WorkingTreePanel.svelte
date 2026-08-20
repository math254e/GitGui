<script lang="ts">
  import { Check, ChevronRight, LoaderCircle } from "@lucide/svelte";
  import type { ChangedFile, CommitFile, RepositorySnapshot } from "$lib/types/repository";
  import WorkingTreeFileList from "$lib/components/WorkingTreeFileList.svelte";

  export type CommitMessageDraft = {
    summary: string;
    description: string;
  };

  export type WorkingTreePanelProps = {
    snapshot: RepositorySnapshot;
    selectedFile: CommitFile | null;
    onSelectFile: (file: CommitFile) => void;
    onStageFile?: (file: ChangedFile) => void;
    onUnstageFile?: (file: ChangedFile) => void;
    onStageAll?: () => void;
    onUnstageAll?: () => void;
    onCommit?: (draft: CommitMessageDraft) => void;
    pending?: boolean;
    disabled?: boolean;
  };

  let {
    snapshot,
    selectedFile,
    onSelectFile,
    onStageFile = () => {},
    onUnstageFile = () => {},
    onStageAll = () => {},
    onUnstageAll = () => {},
    onCommit = () => {},
    pending = false,
    disabled = false,
  }: WorkingTreePanelProps = $props();

  let summary = $state("");
  let description = $state("");
  let fileSectionsOpen = $state({ unstaged: true, staged: true });

  const unstagedFiles = $derived(snapshot.status.changedFiles.filter(hasUnstagedChanges));
  const stagedFiles = $derived(snapshot.status.changedFiles.filter(hasStagedChanges));
  const actionsDisabled = $derived(disabled || pending);
  const commitDisabled = $derived(actionsDisabled || !stagedFiles.length || !summary.trim());

  function hasStagedChanges(file: ChangedFile) {
    return hasStatus(file.indexStatus) && file.indexStatus !== "?";
  }

  function hasUnstagedChanges(file: ChangedFile) {
    return hasStatus(file.worktreeStatus) || file.indexStatus === "?";
  }

  function hasStatus(status: string) {
    return Boolean(status && status !== "." && status !== " ");
  }

  function selectCommitFile(file: CommitFile) {
    onSelectFile(file);
  }

  function submitCommit(event: SubmitEvent) {
    event.preventDefault();

    if (commitDisabled) {
      return;
    }

    onCommit({
      summary: summary.trim(),
      description: description.trim(),
    });
  }

  function toggleFileSection(section: "unstaged" | "staged") {
    fileSectionsOpen[section] = !fileSectionsOpen[section];
  }
</script>

<aside class="min-h-0 border-l border-[var(--app-theme-sidebar-border)] bg-[var(--app-theme-sidebar)]">
  <div class="flex h-full min-h-0 flex-col overflow-hidden px-2 py-2">
    <header class="mb-2 shrink-0">
      <p class="text-xs font-bold uppercase tracking-wide text-[var(--app-theme-sidebar-muted-foreground)]">Working tree</p>
      <div class="mt-1 flex items-baseline justify-between gap-3">
        <h2 class="truncate text-base font-semibold text-[var(--app-theme-text)]">Changes</h2>
        <span class="shrink-0 text-xs text-[var(--app-theme-text-subtle)]">
          {snapshot.status.changedFiles.length} {snapshot.status.changedFiles.length === 1 ? "file" : "files"}
        </span>
      </div>
      {#if snapshot.status.currentBranch}
        <p class="mt-1 truncate text-xs text-[var(--app-theme-text-muted)]">on {snapshot.status.currentBranch}</p>
      {/if}
    </header>

    <div class="min-h-0 flex flex-1 flex-col overflow-hidden">
      <section
        class={fileSectionsOpen.unstaged ? "flex min-h-0 flex-1 flex-col" : "shrink-0"}
        aria-labelledby="unstaged-files-heading"
      >
        <div class="mb-2 flex shrink-0 items-center justify-between gap-3 px-1">
          <div class="flex min-w-0 items-center gap-2">
            <button
              type="button"
              class="inline-flex min-w-0 items-center gap-1 text-left text-xs font-bold uppercase tracking-wide text-[var(--app-theme-text-subtle)] transition-colors hover:text-[var(--app-theme-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)]"
              aria-controls="unstaged-files-list"
              aria-expanded={fileSectionsOpen.unstaged}
              onclick={() => toggleFileSection("unstaged")}
            >
              <ChevronRight
                aria-hidden="true"
                size={14}
                class={`shrink-0 transition-transform ${fileSectionsOpen.unstaged ? "rotate-90" : "rotate-0"}`}
              />
              <span id="unstaged-files-heading" class="truncate">Unstaged Files</span>
            </button>
            <span class="rounded-full bg-[var(--app-theme-sidebar-control-surface)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--app-theme-text-muted)]">
              {unstagedFiles.length}
            </span>
          </div>
          <button
            aria-label="Stage all changes"
            class="shrink-0 rounded px-2 py-1 text-xs font-semibold text-[var(--app-theme-accent)] transition-colors hover:bg-[var(--app-theme-sidebar-row-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)] disabled:cursor-not-allowed disabled:opacity-40"
            disabled={actionsDisabled || !unstagedFiles.length}
            title="Stage all changes"
            type="button"
            onclick={onStageAll}
          >
            Stage all
          </button>
        </div>

        {#if fileSectionsOpen.unstaged}
          <div id="unstaged-files-list" class="min-h-0 flex-1 overflow-hidden">
            {#if unstagedFiles.length}
              <WorkingTreeFileList
                files={unstagedFiles}
                selectedFile={selectedFile}
                treeId="gitgui-working-tree-unstaged"
                actionLabel="Stage"
                onSelectFile={selectCommitFile}
                onAction={onStageFile}
                disabled={actionsDisabled}
              />
            {:else}
              <p class="px-3 py-4 text-sm text-[var(--app-theme-text-subtle)]">No unstaged changes.</p>
            {/if}
          </div>
        {/if}
      </section>

      <section
        class={`border-t border-[var(--app-theme-sidebar-border)] ${fileSectionsOpen.staged ? "flex min-h-0 flex-1 flex-col" : "shrink-0"}`}
        aria-labelledby="staged-files-heading"
      >
        <div class="mb-2 flex shrink-0 items-center justify-between gap-3 px-1 pt-4">
          <div class="flex min-w-0 items-center gap-2">
            <button
              type="button"
              class="inline-flex min-w-0 items-center gap-1 text-left text-xs font-bold uppercase tracking-wide text-[var(--app-theme-text-subtle)] transition-colors hover:text-[var(--app-theme-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)]"
              aria-controls="staged-files-list"
              aria-expanded={fileSectionsOpen.staged}
              onclick={() => toggleFileSection("staged")}
            >
              <ChevronRight
                aria-hidden="true"
                size={14}
                class={`shrink-0 transition-transform ${fileSectionsOpen.staged ? "rotate-90" : "rotate-0"}`}
              />
              <span id="staged-files-heading" class="truncate">Staged Files</span>
            </button>
            <span class="rounded-full bg-[var(--app-theme-sidebar-control-surface)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--app-theme-text-muted)]">
              {stagedFiles.length}
            </span>
          </div>
          <button
            aria-label="Unstage all files"
            class="shrink-0 rounded px-2 py-1 text-xs font-semibold text-[var(--app-theme-text-muted)] transition-colors hover:bg-[var(--app-theme-sidebar-row-hover)] hover:text-[var(--app-theme-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)] disabled:cursor-not-allowed disabled:opacity-40"
            disabled={actionsDisabled || !stagedFiles.length}
            title="Unstage all files"
            type="button"
            onclick={onUnstageAll}
          >
            Unstage all
          </button>
        </div>

        {#if fileSectionsOpen.staged}
          <div id="staged-files-list" class="min-h-0 flex-1 overflow-hidden">
            {#if stagedFiles.length}
              <WorkingTreeFileList
                files={stagedFiles}
                selectedFile={selectedFile}
                treeId="gitgui-working-tree-staged"
                actionLabel="Unstage"
                onSelectFile={selectCommitFile}
                onAction={onUnstageFile}
                disabled={actionsDisabled}
              />
            {:else}
              <p class="px-3 py-4 text-sm text-[var(--app-theme-text-subtle)]">No staged files yet.</p>
            {/if}
          </div>
        {/if}
      </section>
    </div>

    <form class="mt-2 shrink-0 border-t border-[var(--app-theme-sidebar-border)] pt-2" onsubmit={submitCommit}>
      <div class="mb-3 flex items-center justify-between gap-3">
        <label class="text-xs font-bold uppercase tracking-wide text-[var(--app-theme-text-subtle)]" for="commit-summary">
          Commit message
        </label>
        {#if pending}
          <span class="inline-flex items-center gap-1.5 text-xs text-[var(--app-theme-text-subtle)]" role="status">
            <LoaderCircle aria-hidden="true" class="animate-spin" size={13} />
            Committing
          </span>
        {/if}
      </div>

      <input
        id="commit-summary"
        class="mb-2 h-9 w-full rounded-md border border-[var(--app-theme-input)] bg-[var(--app-theme-canvas)] px-3 text-sm text-[var(--app-theme-text)] outline-none placeholder:text-[var(--app-theme-placeholder)] focus:border-[var(--app-theme-focus)] focus:ring-2 focus:ring-[var(--app-theme-focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
        disabled={actionsDisabled}
        placeholder="Summary"
        type="text"
        bind:value={summary}
      />
      <textarea
        id="commit-description"
        class="h-20 w-full resize-none rounded-md border border-[var(--app-theme-input)] bg-[var(--app-theme-canvas)] px-3 py-2 text-sm text-[var(--app-theme-text)] outline-none placeholder:text-[var(--app-theme-placeholder)] focus:border-[var(--app-theme-focus)] focus:ring-2 focus:ring-[var(--app-theme-focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
        aria-label="Commit description"
        disabled={actionsDisabled}
        placeholder="Description (optional)"
        bind:value={description}
      ></textarea>
      <button
        class="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-[var(--app-theme-accent)] bg-[var(--app-theme-accent-surface)] px-3 text-sm font-semibold text-[var(--app-theme-accent-surface-foreground)] transition-colors hover:bg-[var(--app-theme-sidebar-row-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)] disabled:cursor-not-allowed disabled:opacity-45"
        disabled={commitDisabled}
        type="submit"
      >
        {#if pending}
          <LoaderCircle aria-hidden="true" class="animate-spin" size={16} />
          Committing...
        {:else}
          <Check aria-hidden="true" size={16} strokeWidth={2.25} />
          Commit staged files
        {/if}
      </button>
    </form>
  </div>
</aside>
