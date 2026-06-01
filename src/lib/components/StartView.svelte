<script lang="ts">
  import { CloudDownload, FolderOpen, PlusSquare, Search } from "@lucide/svelte";

  type RecentRepo = {
    root: string;
    title: string;
  };

  type Props = {
    recentRepos: RecentRepo[];
    loading: boolean;
    error: string;
    onChooseRepository: () => void;
    onOpenRecent: (path: string) => void;
  };

  let {
    recentRepos,
    loading,
    error,
    onChooseRepository,
    onOpenRecent,
  }: Props = $props();

  let search = $state("");
  const filteredRepos = $derived(
    recentRepos.filter((repo) => {
      const query = search.trim().toLowerCase();

      if (!query) {
        return true;
      }

      return repo.title.toLowerCase().includes(query) || repo.root.toLowerCase().includes(query);
    }),
  );
</script>

<section class="h-full min-h-0 overflow-auto bg-[#f4f6f8] text-[#202124]">
  <div class="mx-auto flex min-h-full w-full max-w-[1350px] flex-col px-8 py-12 lg:px-16 xl:px-24">
    <h1 class="text-[26px] font-medium leading-tight text-[#202124]">Repositories</h1>

    <div class="mt-6 flex flex-wrap items-center gap-3">
      <button
        class="inline-flex h-14 items-center justify-center gap-3 rounded border border-[#d8dde4] bg-white px-4 text-[21px] font-medium text-[#202124] transition hover:bg-[#eef2f5] disabled:cursor-not-allowed disabled:opacity-55"
        type="button"
        disabled={loading}
        onclick={onChooseRepository}
      >
        <FolderOpen aria-hidden="true" class="text-[#6d7784]" size={24} />
        {loading ? "Opening" : "Open"}
      </button>

      <button
        class="inline-flex h-14 items-center justify-center gap-3 rounded border border-[#d8dde4] bg-white px-4 text-[21px] font-medium text-[#6d7784] opacity-75"
        type="button"
        disabled
      >
        <CloudDownload aria-hidden="true" class="text-[#6d7784]" size={24} />
        Clone
      </button>

      <button
        class="inline-flex h-14 items-center justify-center gap-3 rounded border border-[#d8dde4] bg-white px-4 text-[21px] font-medium text-[#6d7784] opacity-75"
        type="button"
        disabled
      >
        <PlusSquare aria-hidden="true" class="text-[#6d7784]" size={24} />
        Create
      </button>
    </div>

    <div class="relative mt-6">
      <Search
        aria-hidden="true"
        class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[#89929d]"
        size={18}
      />
      <label class="sr-only" for="repository-search">Search repositories</label>
      <input
        id="repository-search"
        class="h-9 w-full rounded border border-[#d8dde4] bg-white pr-3 pl-8 text-[16px] text-[#202124] outline-none placeholder:text-[#89929d] focus:border-[#78d5c8]"
        bind:value={search}
        placeholder="Search repositories"
      />
    </div>

    {#if error}
      <div class="mt-4 rounded border border-[#f1c7c7] bg-[#fff0f0] px-4 py-3 text-sm text-[#8b2d2d]">
        {error}
      </div>
    {/if}

    <section class="mt-6">
      <h2 class="mb-2 text-[18px] font-medium text-[#202124]">Recent</h2>

      {#if filteredRepos.length}
        <ul class="space-y-1">
          {#each filteredRepos as repo (repo.root)}
            <li>
              <button
                class="grid w-full min-w-0 grid-cols-[minmax(0,auto)_1fr] items-baseline gap-4 py-0.5 text-left leading-6 transition hover:bg-[#eef2f5]"
                type="button"
                onclick={() => onOpenRecent(repo.root)}
              >
                <span class="truncate text-[18px] font-semibold text-[#4d9d91]">{repo.title}</span>
                <span class="truncate text-[18px] font-medium text-[#6d7784]">{repo.root}</span>
              </button>
            </li>
          {/each}
        </ul>
      {:else if recentRepos.length}
        <p class="py-1 text-[17px] text-[#89929d]">No repositories match your search.</p>
      {:else}
        <p class="py-1 text-[17px] text-[#89929d]">Recently opened repositories will appear here.</p>
      {/if}
    </section>
  </div>
</section>
