<script lang="ts">
  import type { CommitInfo, RepositorySnapshot } from "$lib/types/repository";

  type Props = {
    snapshot: RepositorySnapshot | null;
    selectedCommit: CommitInfo | null;
    onClose?: () => void;
  };

  let { snapshot, selectedCommit, onClose }: Props = $props();

  function formatDate(timestamp: number) {
    return new Date(timestamp * 1000).toLocaleString();
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
      <section class="space-y-5">
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
