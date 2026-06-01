<script lang="ts">
  import type { CommitInfo, RepositorySnapshot } from "$lib/types/repository";

  type Props = {
    snapshot: RepositorySnapshot | null;
    selectedCommit: CommitInfo | null;
    changesSelected: boolean;
    onSelectChanges: () => void;
    onSelectCommit: (commit: CommitInfo) => void;
  };

  let { snapshot, selectedCommit, changesSelected, onSelectChanges, onSelectCommit }: Props = $props();

  function formatDate(timestamp: number) {
    return new Date(timestamp * 1000).toLocaleDateString();
  }
</script>

<section class="min-h-0 bg-white">
  {#if snapshot}
    <div class="flex h-full min-h-0 flex-col">
      <div class="flex h-12 items-center justify-between border-b border-[#edf0f3] px-5">
        <h2 class="text-sm font-bold uppercase text-[#7b8490]">Git Graph</h2>
        <span class="text-xs text-[#89929d]">{snapshot.commits.length} commits</span>
      </div>

      <ol class="min-h-0 flex-1 overflow-auto">
        {#if snapshot.status.changedFiles.length}
          <li>
            <button
              class={`grid w-full grid-cols-[72px_1fr_auto] items-center gap-4 border-b border-[#f0f2f4] px-5 py-3 text-left transition hover:bg-[#f8fafb] ${
                changesSelected ? "bg-[#e9f8f5]" : "bg-white"
              }`}
              type="button"
              onclick={onSelectChanges}
            >
              <span class="relative flex h-8 items-center justify-center">
                <span class="absolute top-1/2 bottom-0 left-1/2 w-px -translate-x-1/2 bg-[#d8dde4]"></span>
                <span class="relative h-4 w-4 rounded border-2 border-[#4d9d91] bg-[#e9f8f5]"></span>
              </span>
              <span class="min-w-0">
                <span class="block truncate text-sm font-semibold text-[#202124]">Changed files</span>
                <span class="block truncate text-xs text-[#6d7784]">
                  {snapshot.status.changedFiles.length} files
                  {#if snapshot.status.currentBranch}
                    on {snapshot.status.currentBranch}
                  {/if}
                </span>
              </span>
              <span class="text-xs font-semibold text-[#4d9d91]">Working tree</span>
            </button>
          </li>
        {/if}

        {#each snapshot.commits as commit, index}
          <li>
            <button
              class={`grid w-full grid-cols-[72px_1fr_auto] items-center gap-4 border-b border-[#f0f2f4] px-5 py-3 text-left transition hover:bg-[#f8fafb] ${
                selectedCommit?.hash === commit.hash ? "bg-[#e9f8f5]" : "bg-white"
              }`}
              type="button"
              onclick={() => onSelectCommit(commit)}
            >
              <span class="relative flex h-8 items-center justify-center">
                {#if index === 0}
                  <span class="absolute top-1/2 bottom-0 left-1/2 w-px -translate-x-1/2 bg-[#d8dde4]"></span>
                {:else}
                  <span class="absolute top-0 bottom-0 left-1/2 w-px -translate-x-1/2 bg-[#d8dde4]"></span>
                {/if}
                <span class="relative h-3 w-3 rounded-full border-2 border-[#4d9d91] bg-white"></span>
              </span>
              <span class="min-w-0">
                <span class="block truncate text-sm font-semibold text-[#202124]">{commit.message}</span>
                <span class="block truncate text-xs text-[#6d7784]">{commit.author} - {formatDate(commit.timestamp)}</span>
              </span>
              <code class="font-mono text-xs text-[#7b8490]">{commit.hash.slice(0, 8)}</code>
            </button>
          </li>
        {/each}
      </ol>
    </div>
  {:else}
    <div class="grid h-full place-items-center p-8 text-center">
      <div>
        <p class="text-sm font-bold uppercase text-[#7b8490]">Git Graph</p>
        <h2 class="mt-2 text-2xl font-semibold text-[#202124]">Open a repository to view history.</h2>
      </div>
    </div>
  {/if}
</section>
