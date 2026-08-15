<script lang="ts">
  import CommitFilesTree from "$lib/components/CommitFilesTree.svelte";
  import type { ChangedFile, CommitFile, RepositorySnapshot } from "$lib/types/repository";

  type Props = {
    snapshot: RepositorySnapshot;
    selectedFile: CommitFile | null;
    onSelectFile: (file: CommitFile) => void;
  };

  let { snapshot, selectedFile, onSelectFile }: Props = $props();

  const changedFiles = $derived(snapshot.status.changedFiles.map(changedFileToCommitFile));

  function changedFileStatus(file: ChangedFile) {
    return `${file.indexStatus}${file.worktreeStatus}`;
  }

  function changedFileToCommitFile(file: ChangedFile): CommitFile {
    return {
      path: file.path,
      originalPath: file.originalPath,
      status: changedFileStatus(file),
    };
  }
</script>

<aside class="min-h-0 border-l border-[var(--app-theme-sidebar-border)] bg-[var(--app-theme-sidebar)]">
  <div class="flex h-full flex-col overflow-auto px-5 py-5">
    <div class="mb-5">
      <h2 class="text-xs font-bold uppercase text-[var(--app-theme-sidebar-muted-foreground)]">Working tree</h2>
    </div>

    <section class="flex min-h-0 flex-1 flex-col space-y-5">
      <div>
        <p class="mb-1 text-xs font-bold uppercase text-[var(--app-theme-text-subtle)]">Working tree</p>
        <h3 class="text-lg font-semibold leading-snug text-[var(--app-theme-text)]">Changed files</h3>
        <p class="mt-1 text-sm text-[var(--app-theme-text-muted)]">
          {snapshot.status.changedFiles.length} changed files
          {#if snapshot.status.currentBranch}
            on {snapshot.status.currentBranch}
          {/if}
        </p>
      </div>

      <div class="space-y-3">
        <label class="block text-xs font-bold uppercase text-[var(--app-theme-text-subtle)]" for="commit-message">
          Commit message
        </label>
        <textarea
          class="h-24 w-full resize-none rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-canvas)] px-3 py-2 text-sm text-[var(--app-theme-text-muted)]"
          disabled
          id="commit-message"
          placeholder="Commit message workflow is planned."
        ></textarea>
        <div class="flex gap-2">
          <button
            class="rounded-md border border-[var(--app-theme-border)] px-3 py-2 text-xs font-semibold text-[var(--app-theme-text-subtle)]"
            disabled
            type="button"
          >
            Stage selected
          </button>
          <button
            class="rounded-md border border-[var(--app-theme-border)] px-3 py-2 text-xs font-semibold text-[var(--app-theme-text-subtle)]"
            disabled
            type="button"
          >
            Commit
          </button>
        </div>
      </div>

      <div class="flex min-h-0 flex-1 flex-col">
        <div class="mb-3 flex items-center justify-between gap-3">
          <p class="text-xs font-bold uppercase text-[var(--app-theme-text-subtle)]">Files</p>
          <span class="text-xs text-[var(--app-theme-text-subtle)]">{snapshot.status.changedFiles.length} files</span>
        </div>

        <CommitFilesTree files={changedFiles} {selectedFile} {onSelectFile} />
      </div>
    </section>
  </div>
</aside>
