<script lang="ts">
  import { CloudDownload, FolderOpen, PlusSquare, Search, X } from "@lucide/svelte";

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
    onCreateRepository: () => void;
    onRemoveRepository: (repositoryId: string) => void | Promise<void>;
    canCreateRepository?: boolean;
    onOpenRepository: (repositoryId: string) => void;
    onRetryConnection?: () => void;
  };

  let {
    repositories,
    loading,
    error,
    connectionError = false,
    onChooseRepository,
    onCreateRepository,
    onRemoveRepository,
    canCreateRepository = false,
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

    <div class="mt-4 flex flex-wrap items-center gap-2">
      <button
        class="inline-flex h-9 items-center justify-center gap-2 rounded-[2px] border border-[var(--app-theme-input)] bg-[var(--app-theme-canvas)] px-3 text-sm font-semibold text-[var(--app-theme-text-secondary)] transition-colors hover:bg-[var(--app-theme-sidebar-row-hover)] hover:text-[var(--app-theme-text)] disabled:cursor-not-allowed disabled:opacity-55"
        type="button"
        disabled={loading}
        onclick={onChooseRepository}
      >
        <FolderOpen aria-hidden="true" class="text-[var(--app-theme-text-muted)]" size={16} />
        {loading ? "Opening" : "Open"}
      </button>

      <button
        class="inline-flex h-9 items-center justify-center gap-2 rounded-[2px] border border-[var(--app-theme-input)] bg-[var(--app-theme-canvas)] px-3 text-sm font-semibold text-[var(--app-theme-text-muted)] opacity-75"
        type="button"
        disabled
      >
        <CloudDownload aria-hidden="true" class="text-[var(--app-theme-text-muted)]" size={16} />
        Clone
      </button>

      <button
        class="inline-flex h-9 items-center justify-center gap-2 rounded-[2px] border border-[var(--app-theme-input)] bg-[var(--app-theme-canvas)] px-3 text-sm font-semibold text-[var(--app-theme-text-secondary)] transition-colors hover:bg-[var(--app-theme-sidebar-row-hover)] hover:text-[var(--app-theme-text)] disabled:cursor-not-allowed disabled:opacity-55"
        type="button"
        disabled={!canCreateRepository || loading}
        title={canCreateRepository ? "Create a repository" : "Create is available in the desktop app"}
        onclick={onCreateRepository}
      >
        <PlusSquare aria-hidden="true" class="text-[var(--app-theme-text-muted)]" size={16} />
        Create
      </button>
    </div>

    <div class="relative mt-4">
      <Search
        aria-hidden="true"
        class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[var(--app-theme-text-subtle)]"
        size={16}
      />
      <label class="sr-only" for="repository-search">Search repositories</label>
      <input
        id="repository-search"
        class="h-9 w-full rounded-[2px] border border-[var(--app-theme-input)] bg-[var(--app-theme-canvas)] pr-3 pl-8 text-sm text-[var(--app-theme-text)] outline-none placeholder:text-[var(--app-theme-placeholder)] focus:border-[var(--app-theme-focus)] focus:ring-2 focus:ring-[var(--app-theme-focus-ring)]"
        bind:value={search}
        placeholder="Search repositories"
      />
    </div>

    {#if error}
      <div class="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[2px] border border-[var(--app-theme-error-border)] bg-[var(--app-theme-error-surface)] px-3 py-2 text-sm text-[var(--app-theme-error-foreground)]">
        <span>{error}</span>
        {#if connectionError && onRetryConnection}
          <button
            class="inline-flex h-8 items-center justify-center rounded-[2px] border border-[var(--app-theme-error-border)] bg-[var(--app-theme-surface-raised)] px-3 text-sm font-medium text-[var(--app-theme-error-foreground)] transition hover:bg-[var(--app-theme-error-surface)] disabled:cursor-not-allowed disabled:opacity-55"
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
              <div class="group relative grid min-w-0 grid-cols-[1fr] items-center gap-2 pr-8 transition hover:bg-[var(--app-theme-sidebar-row-hover)]">
                <button
                  class="grid min-w-0 grid-cols-[minmax(0,auto)_1fr] items-baseline gap-4 py-0.5 text-left leading-6"
                  type="button"
                  onclick={() => onOpenRepository(repo.repositoryId)}
                >
                  <span class="truncate text-[18px] font-semibold text-[var(--app-theme-accent)]">{repo.title}</span>
                  <span class="truncate text-[18px] font-medium text-[var(--app-theme-text-muted)]">{repo.root}</span>
                </button>
                <button
                  class="absolute right-1 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-[2px] text-[var(--app-theme-error)] opacity-0 transition-opacity hover:bg-[var(--app-theme-error-surface)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)] group-hover:opacity-100"
                  type="button"
                  aria-label={`Remove ${repo.title} from GitGui`}
                  title="Remove from GitGui (files stay on disk)"
                  disabled={loading}
                  onclick={() => void onRemoveRepository(repo.repositoryId)}
                >
                  <X aria-hidden="true" size={16} />
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
