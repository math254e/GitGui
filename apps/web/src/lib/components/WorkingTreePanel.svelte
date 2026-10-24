<script lang="ts">
  import { Check, LoaderCircle } from "@lucide/svelte";
  import FileTreeChevron from "$lib/components/FileTreeChevron.svelte";
  import type { GitAmendInfo } from "@gitgui/contracts";
  import type { ChangedFile, CommitFile, RepositorySnapshot } from "$lib/types/repository";
  import WorkingTreeFileList from "$lib/components/WorkingTreeFileList.svelte";

  export type CommitMessageDraft = {
    summary: string;
    description: string;
    amend?: boolean;
    expectedHead?: string;
  };

  export type WorkingTreeDraftState = {
    normal: CommitMessageDraft;
    amend: CommitMessageDraft;
    amendMode: boolean;
    amendHead: string | null;
  };

  export type WorkingTreeDiffSource = "workingTree" | "staged" | "commitWorkingTree";

  export type WorkingTreePanelProps = {
    contextKey?: string | null;
    canStashSelected?: boolean;
    onStashSelected?: (source: "staged" | "unstaged", files: ChangedFile[]) => void;
    snapshot: RepositorySnapshot;
    draft: WorkingTreeDraftState;
    amendInfo: GitAmendInfo | null;
    amendLoading?: boolean;
    onDraftChange: (draft: WorkingTreeDraftState) => void;
    onAmendToggle: (enabled: boolean) => void;
    onDiscardPaths: (paths: string[]) => void;
    selectedPaths: string[];
    selectedPathsSource: WorkingTreeDiffSource | null;
    onSelectionPathsChange: (paths: string[], source: WorkingTreeDiffSource) => void;
    onSelectFile: (file: CommitFile, source: WorkingTreeDiffSource) => void;
    onStageFile?: (file: ChangedFile) => void;
    onStagePaths?: (paths: string[]) => void;
    onUnstageFile?: (file: ChangedFile) => void;
    onUnstagePaths?: (paths: string[]) => void;
    onStageAll?: () => void;
    onUnstageAll?: () => void;
    onCommit?: (draft: CommitMessageDraft) => void;
    pending?: boolean;
    commitPending?: boolean;
    stageActionRunning?: boolean;
    stageQueueWaiting?: boolean;
    stageQueueLabel?: string | null;
    disabled?: boolean;
  };

  let {
    contextKey = null, canStashSelected = false, onStashSelected,
    snapshot,
    draft, amendInfo, amendLoading = false, onDraftChange, onAmendToggle, onDiscardPaths,
    selectedPaths,
    selectedPathsSource,
    onSelectionPathsChange,
    onSelectFile,
    onStageFile = () => {},
    onStagePaths = () => {},
    onUnstageFile = () => {},
    onUnstagePaths = () => {},
    onStageAll = () => {},
    onUnstageAll = () => {},
    onCommit = () => {},
    pending = false,
    commitPending = false,
    stageActionRunning = false,
    stageQueueWaiting = false,
    stageQueueLabel = null,
    disabled = false,
  }: WorkingTreePanelProps = $props();

  const currentDraft = $derived(draft.amendMode ? draft.amend : draft.normal);
  const amendBlockedReason = $derived(amendInfo?.blockedReason ?? (!amendInfo ? "Loading amend availability…" : ""));
  const staleAmend = $derived(draft.amendMode && draft.amendHead !== snapshot.status.headOid);
  let fileSectionsOpen = $state({ unstaged: true, staged: true });
  const initialSelectedPathsSource = readInitialSelectedPathsSource();
  const initialSelectedPaths = readInitialSelectedPaths();
  const initialUnstagedPaths =
    initialSelectedPathsSource === "staged"
      ? []
      : initialSelectedPaths;
  let unstagedSelectedPaths = $state<string[]>(initialUnstagedPaths);
  let stagedSelectedPaths = $state<string[]>(
    initialSelectedPathsSource === "staged"
      ? initialSelectedPaths
      : [],
  );

  const unstagedFiles = $derived(snapshot.status.changedFiles.filter(hasUnstagedChanges));
  const stagedFiles = $derived(snapshot.status.changedFiles.filter(hasStagedChanges));
  const selectedUnstagedFiles = $derived(
    unstagedFiles.filter((file) => unstagedSelectedPaths.includes(file.path)),
  );
  const selectedStagedFiles = $derived(
    stagedFiles.filter((file) => stagedSelectedPaths.includes(file.path)),
  );
  const unstagedActionLabel = $derived(selectedUnstagedFiles.length > 0 ? "Stage selected" : "Stage all");
  const stagedActionLabel = $derived(selectedStagedFiles.length > 0 ? "Unstage selected" : "Unstage all");
  const commitInputsDisabled = $derived(disabled || commitPending);
  const commitDisabled = $derived(disabled || pending || (!draft.amendMode && !stagedFiles.length) || !currentDraft.summary.trim() || (draft.amendMode && (amendLoading || Boolean(amendBlockedReason) || staleAmend)));
  const stageControlsDisabled = $derived(disabled || stageActionRunning || stageQueueWaiting);

  function hasStagedChanges(file: ChangedFile) {
    return hasStatus(file.indexStatus) && file.indexStatus !== "?";
  }

  function hasUnstagedChanges(file: ChangedFile) {
    return hasStatus(file.worktreeStatus) || file.indexStatus === "?";
  }

  function hasStatus(status: string) {
    return Boolean(status && status !== "." && status !== " ");
  }

  function selectUnstagedFile(file: CommitFile) {
    onSelectFile(file, "workingTree");
  }

  function selectStagedFile(file: CommitFile) {
    onSelectFile(file, "staged");
  }

  function handleUnstagedSelection(files: ChangedFile[]) {
    const paths = files.map((file) => file.path);
    unstagedSelectedPaths = paths;
    stagedSelectedPaths = [];
    onSelectionPathsChange(paths, "workingTree");
  }

  function handleStagedSelection(files: ChangedFile[]) {
    const paths = files.map((file) => file.path);
    stagedSelectedPaths = paths;
    unstagedSelectedPaths = [];
    onSelectionPathsChange(paths, "staged");
  }

  function stageSingleFile(file: ChangedFile) {
    const wasSelected = unstagedSelectedPaths.includes(file.path);

    onStageFile(file);

    if (wasSelected) {
      clearSelection();
    }
  }

  function unstageSingleFile(file: ChangedFile) {
    const wasSelected = stagedSelectedPaths.includes(file.path);

    onUnstageFile(file);

    if (wasSelected) {
      clearSelection();
    }
  }

  function stageUnstaged() {
    if (selectedUnstagedFiles.length > 0) {
      const paths = selectedUnstagedFiles.map((file) => file.path);
      clearSelection();
      onStagePaths(paths);
      return;
    }

    clearSelection();
    onStageAll();
  }

  function unstageStaged() {
    if (selectedStagedFiles.length > 0) {
      const paths = selectedStagedFiles.map((file) => file.path);
      clearSelection();
      onUnstagePaths(paths);
      return;
    }

    clearSelection();
    onUnstageAll();
  }

  function clearSelection() {
    unstagedSelectedPaths = [];
    stagedSelectedPaths = [];
    onSelectionPathsChange([], selectedPathsSource ?? "workingTree");
  }

  function readInitialSelectedPaths() {
    return selectedPaths;
  }

  function readInitialSelectedPathsSource() {
    return selectedPathsSource;
  }

  function submitCommit(event: SubmitEvent) {
    event.preventDefault();

    if (commitDisabled) {
      return;
    }

    onCommit({
      summary: currentDraft.summary.trim(),
      description: currentDraft.description.trim(),
      amend: draft.amendMode,
      ...(draft.amendHead ? { expectedHead: draft.amendHead } : {}),
    });
  }

  function editMessage(field: "summary" | "description", value: string) {
    const mode = draft.amendMode ? "amend" : "normal";
    onDraftChange({ ...draft, [mode]: { ...currentDraft, [field]: value } });
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

    <div class="relative min-h-0 flex flex-1 flex-col overflow-hidden" aria-busy={stageQueueWaiting}>
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
              <FileTreeChevron expanded={fileSectionsOpen.unstaged} />
              <span id="unstaged-files-heading" class="truncate">Unstaged Files</span>
            </button>
            <span class="rounded-full bg-[var(--app-theme-sidebar-control-surface)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--app-theme-text-muted)]">
              {unstagedFiles.length}
            </span>
          </div>
          <button
            aria-label={unstagedActionLabel === "Stage selected" ? "Stage selected changes" : "Stage all changes"}
            class="inline-flex h-[22px] shrink-0 items-center justify-center rounded-[2px] border border-[var(--app-theme-accent)]/35 bg-[var(--app-theme-accent)]/10 px-1.5 text-[10px] font-semibold text-[var(--app-theme-accent)] transition-colors hover:border-[var(--app-theme-accent)]/55 hover:bg-[var(--app-theme-accent)]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)] disabled:cursor-not-allowed disabled:opacity-40"
            disabled={stageControlsDisabled || !unstagedFiles.length}
            title={unstagedActionLabel === "Stage selected" ? "Stage selected changes" : "Stage all changes"}
            type="button"
            onclick={stageUnstaged}
          >
            {unstagedActionLabel}
          </button>
        </div>

        {#if fileSectionsOpen.unstaged}
          <div id="unstaged-files-list" class="min-h-0 flex-1 overflow-hidden">
            {#if unstagedFiles.length}
              <WorkingTreeFileList
                {contextKey} {canStashSelected}
                onStashSelected={(files) => onStashSelected?.("unstaged", files)}
                files={unstagedFiles}
                selectedPaths={selectedPathsSource === "workingTree" ? selectedPaths : []}
                treeId="gitgui-working-tree-unstaged"
                actionLabel="Stage"
                onSelectFile={selectUnstagedFile}
                onSelectionChange={handleUnstagedSelection}
                onAction={stageSingleFile}
                onDiscard={(file) => onDiscardPaths([file.path])}
                onDiscardSelected={(files) => onDiscardPaths(files.map((file) => file.path))}
                disabled={stageControlsDisabled}
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
              <FileTreeChevron expanded={fileSectionsOpen.staged} />
              <span id="staged-files-heading" class="truncate">Staged Files</span>
            </button>
            <span class="rounded-full bg-[var(--app-theme-sidebar-control-surface)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--app-theme-text-muted)]">
              {stagedFiles.length}
            </span>
          </div>
          <button
            aria-label={stagedActionLabel === "Unstage selected" ? "Unstage selected files" : "Unstage all files"}
            class="inline-flex h-[22px] shrink-0 items-center justify-center rounded-[2px] border border-[var(--app-theme-error)]/35 bg-[var(--app-theme-error)]/10 px-1.5 text-[10px] font-semibold text-[var(--app-theme-error)] transition-colors hover:border-[var(--app-theme-error)]/55 hover:bg-[var(--app-theme-error)]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)] disabled:cursor-not-allowed disabled:opacity-40"
            disabled={stageControlsDisabled || !stagedFiles.length}
            title={stagedActionLabel === "Unstage selected" ? "Unstage selected files" : "Unstage all files"}
            type="button"
            onclick={unstageStaged}
          >
            {stagedActionLabel}
          </button>
        </div>

        {#if fileSectionsOpen.staged}
          <div id="staged-files-list" class="min-h-0 flex-1 overflow-hidden">
            {#if stagedFiles.length}
              <WorkingTreeFileList
                {contextKey} {canStashSelected}
                onStashSelected={(files) => onStashSelected?.("staged", files)}
                files={stagedFiles}
                selectedPaths={selectedPathsSource === "staged" ? selectedPaths : []}
                treeId="gitgui-working-tree-staged"
                actionLabel="Unstage"
                onSelectFile={selectStagedFile}
                onSelectionChange={handleStagedSelection}
                onAction={unstageSingleFile}
                disabled={stageControlsDisabled}
              />
            {:else}
              <p class="px-3 py-4 text-sm text-[var(--app-theme-text-subtle)]">No staged files yet.</p>
            {/if}
          </div>
        {/if}
      </section>
      {#if stageQueueWaiting}
        <div class="absolute inset-0 z-20 flex items-center justify-center bg-[var(--app-theme-sidebar)]/75 backdrop-blur-[1px]" role="status" aria-live="polite">
          <span class="inline-flex items-center gap-2.5 text-sm font-medium text-[var(--app-theme-text-subtle)]">
            <LoaderCircle aria-hidden="true" class="animate-spin" size={18} strokeWidth={2} />
            {stageQueueLabel ?? "Waiting to stage"}…
          </span>
        </div>
      {/if}
    </div>

    <form class="mt-2 shrink-0 border-t border-[var(--app-theme-sidebar-border)] pt-2" onsubmit={submitCommit}>
      <div class="mb-3 flex items-center justify-between gap-3">
        <label class="text-xs font-bold uppercase tracking-wide text-[var(--app-theme-text-subtle)]" for="commit-summary">
          Commit message
        </label>
        {#if commitPending}
          <span class="inline-flex items-center gap-1.5 text-xs text-[var(--app-theme-text-subtle)]" role="status">
            <LoaderCircle aria-hidden="true" class="animate-spin" size={13} />
            Committing
          </span>
        {/if}
      </div>

      <label class="mb-2 flex items-center gap-2 text-xs" title={amendBlockedReason}>
        <span class="relative inline-flex size-3.5 shrink-0">
          <input
            class="peer size-3.5 appearance-none rounded-none border border-[var(--app-theme-input)] bg-[var(--app-theme-canvas)] checked:border-[var(--app-theme-accent)] checked:bg-[var(--app-theme-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)] disabled:cursor-not-allowed disabled:opacity-50"
            type="checkbox"
            checked={draft.amendMode}
            disabled={commitInputsDisabled || amendLoading || (!draft.amendMode && Boolean(amendBlockedReason))}
            onchange={(event) => onAmendToggle(event.currentTarget.checked)}
          />
          <Check aria-hidden="true" class="pointer-events-none absolute left-px top-px hidden text-[var(--app-theme-accent-foreground)] peer-checked:block peer-disabled:opacity-50" size={12} strokeWidth={2.5} />
        </span>
        Amend last commit
      </label>
      {#if draft.amendMode}
        <p class="mb-2 text-xs text-[var(--app-theme-text-muted)]" role="status">
          {staleAmend ? "HEAD changed. Turn amend off and on to review the new commit." : amendBlockedReason || "Replaces the current commit, including if it was published. Only staged changes are included."}
        </p>
      {:else if amendInfo?.blockedReason}
        <p class="mb-2 text-xs text-[var(--app-theme-text-muted)]">{amendInfo.blockedReason}</p>
      {/if}

      <input
        id="commit-summary"
        class="mb-2 block h-9 w-full rounded-[2px] border border-[var(--app-theme-input)] bg-[var(--app-theme-canvas)] px-3 text-sm text-[var(--app-theme-text)] outline-none placeholder:text-[var(--app-theme-placeholder)] focus:border-[var(--app-theme-focus)] focus:ring-2 focus:ring-[var(--app-theme-focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
        disabled={commitInputsDisabled}
        placeholder="Summary"
        type="text"
        value={currentDraft.summary}
        oninput={(event) => editMessage("summary", event.currentTarget.value)}
      />
      <textarea
        id="commit-description"
        class="block h-20 w-full resize-none rounded-[2px] border border-[var(--app-theme-input)] bg-[var(--app-theme-canvas)] px-3 py-2 text-sm text-[var(--app-theme-text)] outline-none placeholder:text-[var(--app-theme-placeholder)] focus:border-[var(--app-theme-focus)] focus:ring-2 focus:ring-[var(--app-theme-focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
        aria-label="Commit description"
        disabled={commitInputsDisabled}
        placeholder="Description (optional)"
        value={currentDraft.description}
        oninput={(event) => editMessage("description", event.currentTarget.value)}
      ></textarea>
      <button
        class="mt-2 flex h-10 w-full items-center justify-center gap-2 rounded-[2px] border border-[var(--app-theme-accent)] bg-[var(--app-theme-accent-surface)] px-3 text-sm font-semibold text-[var(--app-theme-accent-surface-foreground)] transition-colors hover:bg-[var(--app-theme-sidebar-row-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)] disabled:cursor-not-allowed disabled:opacity-45"
        disabled={commitDisabled}
        type="submit"
      >
        {#if commitPending}
          <LoaderCircle aria-hidden="true" class="animate-spin" size={16} />
          Committing...
        {:else}
          <Check aria-hidden="true" size={16} strokeWidth={2.25} />
          {draft.amendMode ? "Amend last commit" : "Commit staged files"}
        {/if}
      </button>
    </form>
  </div>
</aside>
