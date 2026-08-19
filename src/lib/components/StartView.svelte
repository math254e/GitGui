<script lang="ts">
  import { CloudDownload, FolderOpen, PlusSquare, Search } from "@lucide/svelte";

  type Repository = {
    repositoryId: string;
    root: string;
    title: string;
  };

  type Props = {
    repositories: Repository[];
    loading: boolean;
    error: string;
    connectionError?: boolean;
    onChooseRepository: () => void;
    onOpenRepository: (repositoryId: string) => void;
    onRetryConnection?: () => void;
  };

  let {
    repositories,
    loading,
    error,
    connectionError = false,
    onChooseRepository,
    onOpenRepository,
    onRetryConnection,
  }: Props = $props();

  let search = $state("");
  const filteredRepos = $derived(
    repositories.filter((repo) => {
      const query = search.trim().toLowerCase();

      if (!query) {
        return true;
      }

      return repo.title.toLowerCase().includes(query) || repo.root.toLowerCase().includes(query);
    }),
  );
</script>

<section class="h-full min-h-0 overflow-auto bg-[var(--app-theme-canvas)] text-[var(--app-theme-text)]">
  <div class="mx-auto flex min-h-full w-full max-w-[1350px] flex-col px-8 py-12 lg:px-16 xl:px-24">
    <h1 class="text-[26px] font-medium leading-tight text-[var(--app-theme-text)]">Repositories</h1>

    <div class="mt-6 flex flex-wrap items-center gap-3">
      <button
        class="inline-flex h-14 items-center justify-center gap-3 rounded border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-raised)] px-4 text-[21px] font-medium text-[var(--app-theme-text)] transition hover:bg-[var(--app-theme-sidebar-row-hover)] disabled:cursor-not-allowed disabled:opacity-55"
        type="button"
        disabled={loading}
        onclick={onChooseRepository}
      >
        <FolderOpen aria-hidden="true" class="text-[var(--app-theme-text-muted)]" size={24} />
        {loading ? "Opening" : "Open"}
      </button>

      <button
        class="inline-flex h-14 items-center justify-center gap-3 rounded border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-raised)] px-4 text-[21px] font-medium text-[var(--app-theme-text-muted)] opacity-75"
        type="button"
        disabled
      >
        <CloudDownload aria-hidden="true" class="text-[var(--app-theme-text-muted)]" size={24} />
        Clone
      </button>

      <button
        class="inline-flex h-14 items-center justify-center gap-3 rounded border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-raised)] px-4 text-[21px] font-medium text-[var(--app-theme-text-muted)] opacity-75"
        type="button"
        disabled
      >
        <PlusSquare aria-hidden="true" class="text-[var(--app-theme-text-muted)]" size={24} />
        Create
      </button>
    </div>

    <div class="relative mt-6">
      <Search
        aria-hidden="true"
        class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[var(--app-theme-text-subtle)]"
        size={18}
      />
      <label class="sr-only" for="repository-search">Search repositories</label>
      <input
        id="repository-search"
        class="h-9 w-full rounded border border-[var(--app-theme-border)] bg-[var(--app-theme-input)] pr-3 pl-8 text-[16px] text-[var(--app-theme-text)] outline-none placeholder:text-[var(--app-theme-text-placeholder)] focus:border-[var(--app-theme-focus)]"
        bind:value={search}
        placeholder="Search repositories"
      />
    </div>

    {#if error}
      <div class="mt-4 flex flex-wrap items-center justify-between gap-3 rounded border border-[var(--app-theme-error-border)] bg-[var(--app-theme-error-surface)] px-4 py-3 text-sm text-[var(--app-theme-error-foreground)]">
        <span>{error}</span>
        {#if connectionError && onRetryConnection}
          <button
            class="inline-flex h-8 items-center justify-center rounded border border-[var(--app-theme-error-border)] bg-[var(--app-theme-surface-raised)] px-3 text-sm font-medium text-[var(--app-theme-error-foreground)] transition hover:bg-[var(--app-theme-error-surface)] disabled:cursor-not-allowed disabled:opacity-55"
            type="button"
            disabled={loading}
            onclick={onRetryConnection}
          >
            {loading ? "Restarting…" : "Retry connection"}
          </button>
        {/if}
      </div>
    {/if}

    <section class="mt-6">
      <h2 class="mb-2 text-[18px] font-medium text-[var(--app-theme-text)]">All repositories</h2>

      {#if filteredRepos.length}
        <ul class="space-y-1">
          {#each filteredRepos as repo (repo.repositoryId)}
            <li>
              <div class="grid min-w-0 grid-cols-[1fr] items-center gap-2 transition hover:bg-[var(--app-theme-sidebar-row-hover)]">
                <button
                  class="grid min-w-0 grid-cols-[minmax(0,auto)_1fr] items-baseline gap-4 py-0.5 text-left leading-6"
                  type="button"
                  onclick={() => onOpenRepository(repo.repositoryId)}
                >
                  <span class="truncate text-[18px] font-semibold text-[var(--app-theme-accent)]">{repo.title}</span>
                  <span class="truncate text-[18px] font-medium text-[var(--app-theme-text-muted)]">{repo.root}</span>
                </button>
              </div>
            </li>
          {/each}
        </ul>
      {:else if repositories.length}
        <p class="py-1 text-[17px] text-[var(--app-theme-text-subtle)]">No repositories match your search.</p>
      {:else}
        <p class="py-1 text-[17px] text-[var(--app-theme-text-subtle)]">No repositories are configured on this server.</p>
      {/if}
    </section>
  </div>
</section>
