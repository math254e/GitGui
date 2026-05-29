<script lang="ts">
  import type { RepositorySnapshot } from "$lib/types/repository";

  type Props = {
    repositoryPath: string;
    snapshot: RepositorySnapshot | null;
    loading: boolean;
    error: string;
    onOpenRepository: (event: Event) => void;
  };

  let { repositoryPath = $bindable(), snapshot, loading, error, onOpenRepository }: Props = $props();
</script>

<header class="flex h-20 min-h-20 items-center gap-5 border-b border-[#d8dde4] bg-white px-5">
  <div class="min-w-36">
    <p class="text-xs font-bold uppercase text-[#4d9d91]">GitGui</p>
    <h1 class="text-xl font-semibold text-[#202124]">Repository Workspace</h1>
  </div>

  <form class="flex min-w-0 flex-1 items-center gap-2.5" onsubmit={onOpenRepository}>
    <label class="sr-only" for="repository-path">Repository path</label>
    <input
      class="h-10 min-w-0 flex-1 rounded-md border border-[#d8dde4] bg-[#f8fafb] px-3 text-sm text-[#202124] outline-none transition focus:border-[#78d5c8] focus:bg-white"
      id="repository-path"
      bind:value={repositoryPath}
      placeholder="D:\ProgrammingProjects\GitGui"
    />
    <button
      class="h-10 rounded-md bg-[#78d5c8] px-4 text-sm font-bold text-[#10201d] transition hover:bg-[#66c7b9] disabled:cursor-not-allowed disabled:opacity-55"
      type="submit"
      disabled={loading || !repositoryPath.trim()}
    >
      {loading ? "Loading" : "Open"}
    </button>
  </form>

  {#if snapshot}
    <div class="hidden min-w-0 max-w-80 text-right lg:block">
      <p class="truncate text-sm font-semibold text-[#202124]">{snapshot.status.currentBranch ?? "Detached HEAD"}</p>
      <p class="truncate text-xs text-[#6d7784]">{snapshot.info.root}</p>
    </div>
  {/if}
</header>

{#if error}
  <div class="border-b border-[#f1c7c7] bg-[#fff0f0] px-5 py-2 text-sm text-[#8b2d2d]">
    {error}
  </div>
{/if}
