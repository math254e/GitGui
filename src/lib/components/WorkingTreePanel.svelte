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

<aside class="min-h-0 border-l border-[#d8dde4] bg-[#fbfcfd]">
  <div class="flex h-full flex-col overflow-auto px-5 py-5">
    <div class="mb-5">
      <h2 class="text-xs font-bold uppercase text-[#7b8490]">Working tree</h2>
    </div>

    <section class="flex min-h-0 flex-1 flex-col space-y-5">
      <div>
        <p class="mb-1 text-xs font-bold uppercase text-[#89929d]">Working tree</p>
        <h3 class="text-lg font-semibold leading-snug text-[#202124]">Changed files</h3>
        <p class="mt-1 text-sm text-[#6d7784]">
          {snapshot.status.changedFiles.length} changed files
          {#if snapshot.status.currentBranch}
            on {snapshot.status.currentBranch}
          {/if}
        </p>
      </div>

      <div class="space-y-3">
        <label class="block text-xs font-bold uppercase text-[#89929d]" for="commit-message">
          Commit message
        </label>
        <textarea
          class="h-24 w-full resize-none rounded-md border border-[#d8dde4] bg-[#f4f6f8] px-3 py-2 text-sm text-[#89929d]"
          disabled
          id="commit-message"
          placeholder="Commit message workflow is planned."
        ></textarea>
        <div class="flex gap-2">
          <button
            class="rounded-md border border-[#d8dde4] px-3 py-2 text-xs font-semibold text-[#89929d]"
            disabled
            type="button"
          >
            Stage selected
          </button>
          <button
            class="rounded-md border border-[#d8dde4] px-3 py-2 text-xs font-semibold text-[#89929d]"
            disabled
            type="button"
          >
            Commit
          </button>
        </div>
      </div>

      <div class="flex min-h-0 flex-1 flex-col">
        <div class="mb-3 flex items-center justify-between gap-3">
          <p class="text-xs font-bold uppercase text-[#89929d]">Files</p>
          <span class="text-xs text-[#89929d]">{snapshot.status.changedFiles.length} files</span>
        </div>

        <CommitFilesTree files={changedFiles} {selectedFile} {onSelectFile} />
      </div>
    </section>
  </div>
</aside>
