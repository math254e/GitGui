<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import CommitFilesTree from "$lib/components/CommitFilesTree.svelte";
  import type { CommitFile, CommitInfo, RepositorySnapshot } from "$lib/types/repository";

  type Props = {
    snapshot: RepositorySnapshot | null;
    selectedCommit: CommitInfo | null;
    selectedFile: CommitFile | null;
    onSelectFile: (file: CommitFile) => void;
    onClose?: () => void;
  };

  let { snapshot, selectedCommit, selectedFile, onSelectFile, onClose }: Props = $props();
  let commitFiles = $state<CommitFile[]>([]);
  let filesLoading = $state(false);
  let filesError = $state("");
  let activeFilesRequest = 0;

  $effect(() => {
    const repositoryPath = snapshot?.info.root;
    const commitHash = selectedCommit?.hash;

    if (!repositoryPath || !commitHash) {
      commitFiles = [];
      filesError = "";
      filesLoading = false;
      return;
    }

    void loadFiles(repositoryPath, commitHash);
  });

  function formatDate(timestamp: number) {
    return new Date(timestamp * 1000).toLocaleString();
  }

  async function loadFiles(repositoryPath: string, commitHash: string) {
    const request = ++activeFilesRequest;
    commitFiles = [];
    filesError = "";
    filesLoading = true;

    try {
      const files = await invoke<CommitFile[]>("load_commit_files", {
        path: repositoryPath,
        commitHash,
      });

      if (request === activeFilesRequest) {
        commitFiles = files;
      }
    } catch (caught) {
      if (request === activeFilesRequest) {
        filesError = formatError(caught);
      }
    } finally {
      if (request === activeFilesRequest) {
        filesLoading = false;
      }
    }
  }

  function formatError(caught: unknown) {
    if (typeof caught === "object" && caught && "message" in caught) {
      const details =
        "stderr" in caught && typeof caught.stderr === "string" && caught.stderr
          ? ` ${caught.stderr}`
          : "";
      return `${caught.message}${details}`;
    }

    return String(caught);
  }
</script>

<aside class="min-h-0 border-l border-[#d8dde4] bg-[#fbfcfd]">
  <div class="flex h-full flex-col overflow-auto px-5 py-5">
    <div class="mb-5 flex items-center justify-between gap-3">
      <h2 class="text-xs font-bold uppercase text-[#7b8490]">Details panel</h2>
      {#if onClose}
        <button
          class="rounded-md border border-[#d8dde4] px-2 py-1 text-xs font-semibold text-[#36414d] transition hover:bg-[#eef2f5]"
          type="button"
          onclick={onClose}
        >
          Close
        </button>
      {/if}
    </div>

    {#if selectedCommit}
      <section class="flex min-h-0 flex-1 flex-col space-y-5">
        <div>
          <p class="mb-1 text-xs font-bold uppercase text-[#89929d]">Commit</p>
          <h3 class="text-lg font-semibold leading-snug text-[#202124]">{selectedCommit.message}</h3>
        </div>

        <dl class="space-y-4 text-sm">
          <div>
            <dt class="text-xs font-bold uppercase text-[#89929d]">Hash</dt>
            <dd class="mt-1 break-all font-mono text-[#36414d]">{selectedCommit.hash}</dd>
          </div>
          <div>
            <dt class="text-xs font-bold uppercase text-[#89929d]">Author</dt>
            <dd class="mt-1 text-[#36414d]">{selectedCommit.author}</dd>
          </div>
          <div>
            <dt class="text-xs font-bold uppercase text-[#89929d]">Date</dt>
            <dd class="mt-1 text-[#36414d]">{formatDate(selectedCommit.timestamp)}</dd>
          </div>
          <div>
            <dt class="text-xs font-bold uppercase text-[#89929d]">Parents</dt>
            <dd class="mt-1 text-[#36414d]">{selectedCommit.parents.length || "None"}</dd>
          </div>
        </dl>

        <div class="flex min-h-0 flex-1 flex-col">
          <div class="mb-3 flex items-center justify-between gap-3">
            <p class="text-xs font-bold uppercase text-[#89929d]">Files</p>
            {#if !filesLoading && !filesError}
              <span class="text-xs text-[#89929d]">{commitFiles.length} files</span>
            {/if}
          </div>

          {#if filesLoading}
            <div class="rounded-md border border-[#d8dde4] px-3 py-3 text-sm text-[#89929d]">
              Loading files...
            </div>
          {:else if filesError}
            <div class="rounded-md border border-[#f0c3bd] bg-[#fff7f5] px-3 py-3 text-sm text-[#9f3f33]">
              {filesError}
            </div>
          {:else if commitFiles.length}
            <CommitFilesTree
              files={commitFiles}
              {selectedFile}
              {onSelectFile}
            />
          {:else}
            <div class="rounded-md border border-[#d8dde4] px-3 py-3 text-sm text-[#89929d]">
              This commit does not list file changes.
            </div>
          {/if}
        </div>
      </section>
    {:else if snapshot}
      <section class="space-y-4 text-sm">
        <div>
          <p class="text-xs font-bold uppercase text-[#89929d]">Repository</p>
          <p class="mt-1 break-all text-[#36414d]">{snapshot.info.root}</p>
        </div>
        <div>
          <p class="text-xs font-bold uppercase text-[#89929d]">Branch</p>
          <p class="mt-1 text-[#36414d]">{snapshot.status.currentBranch ?? "Detached HEAD"}</p>
        </div>
        <div>
          <p class="text-xs font-bold uppercase text-[#89929d]">Status</p>
          <p class="mt-1 text-[#36414d]">{snapshot.status.changedFiles.length} changed files</p>
        </div>
      </section>
    {:else}
      <p class="text-sm text-[#89929d]">Repository details will appear here.</p>
    {/if}
  </div>
</aside>
