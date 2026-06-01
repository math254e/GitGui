<script lang="ts">
  import { GitBranchPlus, GitPullRequestCreate, Plus, Search } from "@lucide/svelte";

  type RecentRepo = {
    root: string;
    title: string;
  };

  type Props = {
    repositoryPath: string;
    recentRepos: RecentRepo[];
    loading: boolean;
    error: string;
    onOpenRepository: (event: Event) => void;
    onOpenRecent: (path: string) => void;
  };

  let {
    repositoryPath = $bindable(),
    recentRepos,
    loading,
    error,
    onOpenRepository,
    onOpenRecent,
  }: Props = $props();
</script>

<section class="h-full min-h-0 overflow-auto bg-[#f4f6f8]">
  <div class="mx-auto flex min-h-full w-full max-w-5xl flex-col px-6 py-10">
    <div class="mb-8">
      <p class="text-xs font-bold uppercase text-[#4d9d91]">GitGui</p>
      <h1 class="mt-2 text-3xl font-semibold text-[#202124]">Start</h1>
    </div>

    <div class="grid gap-5 lg:grid-cols-[1.3fr_0.7fr]">
      <section class="rounded-lg border border-[#d8dde4] bg-white p-5">
        <h2 class="text-sm font-bold uppercase text-[#7b8490]">Open repository</h2>
        <form class="mt-4 flex flex-col gap-3 sm:flex-row" onsubmit={onOpenRepository}>
          <label class="sr-only" for="repository-path">Repository path</label>
          <input
            class="h-10 min-w-0 flex-1 rounded-md border border-[#d8dde4] bg-[#f8fafb] px-3 text-sm text-[#202124] outline-none transition focus:border-[#78d5c8] focus:bg-white"
            id="repository-path"
            bind:value={repositoryPath}
            placeholder="D:\ProgrammingProjects\GitGui"
          />
          <button
            class="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-[#78d5c8] px-4 text-sm font-bold text-[#10201d] transition hover:bg-[#66c7b9] disabled:cursor-not-allowed disabled:opacity-55"
            type="submit"
            disabled={loading || !repositoryPath.trim()}
          >
            <Search aria-hidden="true" size={16} />
            {loading ? "Opening" : "Open"}
          </button>
        </form>

        {#if error}
          <div class="mt-4 rounded-md border border-[#f1c7c7] bg-[#fff0f0] px-4 py-3 text-sm text-[#8b2d2d]">
            {error}
          </div>
        {/if}
      </section>

      <section class="rounded-lg border border-[#d8dde4] bg-white p-5">
        <h2 class="text-sm font-bold uppercase text-[#7b8490]">New workspace</h2>
        <div class="mt-4 grid gap-3">
          <button
            class="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-[#d8dde4] bg-[#f8fafb] px-4 text-sm font-semibold text-[#6d7784]"
            type="button"
            disabled
          >
            <GitBranchPlus aria-hidden="true" size={16} />
            Clone repository
          </button>
          <button
            class="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-[#d8dde4] bg-[#f8fafb] px-4 text-sm font-semibold text-[#6d7784]"
            type="button"
            disabled
          >
            <Plus aria-hidden="true" size={16} />
            Create repository
          </button>
        </div>
      </section>
    </div>

    <section class="mt-5 rounded-lg border border-[#d8dde4] bg-white p-5">
      <div class="mb-3 flex items-center justify-between gap-3">
        <h2 class="text-sm font-bold uppercase text-[#7b8490]">Recent repositories</h2>
        <GitPullRequestCreate aria-hidden="true" class="text-[#89929d]" size={16} />
      </div>

      {#if recentRepos.length}
        <ul class="divide-y divide-[#edf0f3]">
          {#each recentRepos as repo (repo.root)}
            <li>
              <button
                class="flex w-full min-w-0 flex-col py-3 text-left transition hover:bg-[#f8fafb] sm:px-2"
                type="button"
                onclick={() => onOpenRecent(repo.root)}
              >
                <span class="truncate text-sm font-semibold text-[#202124]">{repo.title}</span>
                <span class="mt-1 break-all text-xs text-[#6d7784]">{repo.root}</span>
              </button>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="py-3 text-sm text-[#89929d]">Recently opened repositories will appear here.</p>
      {/if}
    </section>
  </div>
</section>
