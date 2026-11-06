<script lang="ts">
  import { CloudDownload, FolderOpen, PlusSquare, Search, X } from "@lucide/svelte";
  import { displayHostPath } from "$lib/display-host-path";
  import GroupedRepositoriesHome, {
    type GroupedRepository,
    type GroupedRepositoryTarget,
  } from "./GroupedRepositoriesHome.svelte";

  type Repository = {
    repositoryId: string;
    root: string;
    title: string;
    missing?: boolean;
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
    canOpenRepository?: boolean;
    canRemoveRepository?: boolean;
    openUnavailableReason?: string;
    createUnavailableReason?: string;
    removeUnavailableReason?: string;
    onOpenRepository: (repositoryId: string) => void;
    onRetryConnection?: () => void;
    /** When supplied with onOpenScopedRepository, replaces the legacy flat list. */
    groupedRepositories?: readonly GroupedRepository[];
    onOpenScopedRepository?: (target: GroupedRepositoryTarget) => void;
    onRemoveScopedRepository?: (target: GroupedRepositoryTarget) => void | Promise<void>;
    environments?: readonly { id: string; label: string; primary: boolean; canOpen?: boolean; canCreate: boolean; openReason?: string; createReason?: string }[];
    onChooseRepositoryForEnvironment?: (environmentId: string) => void;
    onCreateRepositoryForEnvironment?: (environmentId: string) => void;
    environmentCatalogs?: readonly { id: string; label: string; loading: boolean; error: string; connectionStatus: string }[];
    onRetryEnvironmentCatalog?: (environmentId: string) => void;
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
    canOpenRepository = false,
    canRemoveRepository = false,
    openUnavailableReason = "Session authorization is unavailable.",
    createUnavailableReason = "Session authorization is unavailable.",
    removeUnavailableReason = "Session authorization is unavailable.",
    onOpenRepository,
    onRetryConnection,
    groupedRepositories,
    onOpenScopedRepository,
    onRemoveScopedRepository,
    environments,
    onChooseRepositoryForEnvironment,
    onCreateRepositoryForEnvironment,
    environmentCatalogs = [],
    onRetryEnvironmentCatalog,
  }: Props = $props();

  let search = $state("");
  let operationEnvironmentId = $state("");
  const canCreateHere = $derived(environments === undefined ? canCreateRepository : environments.find((entry) => entry.id === operationEnvironmentId)?.canCreate === true);
  const operationEnvironment = $derived(environments?.find((entry) => entry.id === operationEnvironmentId));
  const canOpenHere = $derived(environments === undefined ? canOpenRepository : operationEnvironment?.canOpen === true);
  const openReason = $derived(operationEnvironment?.openReason || openUnavailableReason);
  const createReason = $derived(operationEnvironment?.createReason || createUnavailableReason);
  $effect(() => {
    if (!environments?.some((entry) => entry.id === operationEnvironmentId)) {
      operationEnvironmentId = environments?.find((entry) => entry.primary)?.id ?? environments?.[0]?.id ?? "";
    }
  });
  const filteredRepos = $derived(
    repositories.filter((repo) => {
      const query = search.trim().toLowerCase();

      if (!query) {
        return true;
      }

      return repo.title.toLowerCase().includes(query) || repo.root.toLowerCase().includes(query) || displayHostPath(repo.root).toLowerCase().includes(query);
    }),
  );
</script>

<section class="h-full min-h-0 overflow-auto bg-[var(--app-theme-canvas)] text-[var(--app-theme-text)]">
  <div class="mx-auto flex min-h-full w-full max-w-[1120px] flex-col px-5 py-6 sm:px-8 lg:px-10">
    <header class="flex flex-wrap items-center justify-between gap-x-5 gap-y-3 border-b border-[var(--app-theme-border)] pb-4">
      <div class="flex min-w-0 items-baseline gap-3">
        <h1 class="text-xl font-semibold leading-tight text-[var(--app-theme-text)]">Repositories</h1>
        <span class="text-xs text-[var(--app-theme-text-muted)]">Open, create, and manage repository locations</span>
      </div>

    <div class="flex flex-wrap items-center gap-2">
      <button
        class="inline-flex h-8 items-center justify-center gap-2 rounded-[3px] border border-[var(--app-theme-input)] bg-[var(--app-theme-surface)] px-3 text-sm font-medium text-[var(--app-theme-text)] transition-colors hover:bg-[var(--app-theme-sidebar-row-hover)] disabled:cursor-not-allowed disabled:opacity-55 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--app-theme-focus)]"
        type="button"
        disabled={loading || !canOpenHere}
        title={canOpenHere ? "Open a repository path" : openReason}
        onclick={() => onChooseRepositoryForEnvironment && operationEnvironmentId ? onChooseRepositoryForEnvironment(operationEnvironmentId) : onChooseRepository()}
      >
        <FolderOpen aria-hidden="true" class="text-[var(--app-theme-text-muted)]" size={16} />
        {loading ? "Opening" : "Open"}
      </button>

      <button
        class="inline-flex h-8 items-center justify-center gap-2 rounded-[3px] border border-[var(--app-theme-input)] bg-[var(--app-theme-surface)] px-3 text-sm font-medium text-[var(--app-theme-text-muted)] disabled:cursor-not-allowed disabled:opacity-60"
        type="button"
        disabled
      >
        <CloudDownload aria-hidden="true" class="text-[var(--app-theme-text-muted)]" size={16} />
        Clone
      </button>

      <button
        class="inline-flex h-8 items-center justify-center gap-2 rounded-[3px] border border-[var(--app-theme-input)] bg-[var(--app-theme-surface)] px-3 text-sm font-medium text-[var(--app-theme-text)] transition-colors hover:bg-[var(--app-theme-sidebar-row-hover)] disabled:cursor-not-allowed disabled:opacity-55 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--app-theme-focus)]"
        type="button"
        disabled={!canCreateHere || loading}
        title={canCreateHere ? "Create a repository" : createReason}
        onclick={() => onCreateRepositoryForEnvironment && operationEnvironmentId ? onCreateRepositoryForEnvironment(operationEnvironmentId) : onCreateRepository()}
      >
        <PlusSquare aria-hidden="true" class="text-[var(--app-theme-text-muted)]" size={16} />
        Create
      </button>
      {#if environments && environments.length > 0}
        <label class="sr-only" for="repository-operation-environment">Environment for open and create</label>
        <select id="repository-operation-environment" value={operationEnvironmentId} onchange={(event) => { operationEnvironmentId = event.currentTarget.value; }} disabled={loading}
          class="h-8 max-w-52 rounded-[3px] border border-[var(--app-theme-input)] bg-[var(--app-theme-surface)] px-2 text-sm text-[var(--app-theme-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--app-theme-focus)]">
          {#each environments as environment (environment.id)}<option value={environment.id}>{environment.label}</option>{/each}
        </select>
      {/if}
    </div>
    </header>

    {#if !canOpenHere || !canCreateHere}
      <p class="mt-2 text-sm text-[var(--app-theme-text-secondary)]" aria-label="Repository action availability">{!canOpenHere && !canCreateHere && openReason === createReason ? `Open and Create: ${openReason}` : [!canOpenHere ? `Open: ${openReason}` : "", !canCreateHere ? `Create: ${createReason}` : ""].filter(Boolean).join(" · ")}</p>
    {/if}

    {#if error}
      <div class="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[2px] border border-[var(--app-theme-error-border)] bg-[var(--app-theme-error-surface)] px-3 py-2 text-sm text-[var(--app-theme-error-foreground)]">
        <span>{error}</span>
        {#if connectionError && onRetryConnection}
          <button class="inline-flex h-8 items-center justify-center rounded-[2px] border border-[var(--app-theme-error-border)] bg-[var(--app-theme-surface-raised)] px-3 text-sm font-medium text-[var(--app-theme-error-foreground)] transition hover:bg-[var(--app-theme-error-surface)] disabled:cursor-not-allowed disabled:opacity-55"
            type="button" disabled={loading} onclick={onRetryConnection}>
            {loading ? "Restarting…" : "Retry connection"}
          </button>
        {/if}
      </div>
    {/if}

    {#if groupedRepositories !== undefined && onOpenScopedRepository}
      {#each environmentCatalogs as catalog (catalog.id)}
        {#if catalog.loading || catalog.error || catalog.connectionStatus !== "connected"}
          <div class="mt-3 flex flex-wrap items-center justify-between gap-3 border-l-2 border-[var(--app-theme-focus)] bg-[var(--app-theme-surface-raised)] px-3 py-2 text-sm text-[var(--app-theme-text-secondary)]" aria-label={`${catalog.label} repositories`}>
            <p role={catalog.error ? "alert" : "status"}>
              <span class="font-medium text-[var(--app-theme-text)]">{catalog.label}:</span>
              {catalog.error || (catalog.loading ? "Loading repositories…" : catalog.connectionStatus === "offline" ? "Offline" : catalog.connectionStatus === "blocked" ? "Connection needs attention" : "Connecting…")}
            </p>
            {#if onRetryEnvironmentCatalog && (catalog.error || catalog.connectionStatus === "blocked" || catalog.connectionStatus === "offline")}
              <button class="rounded-[3px] border border-[var(--app-theme-input)] bg-[var(--app-theme-surface)] px-3 py-1 text-sm text-[var(--app-theme-text)] hover:bg-[var(--app-theme-sidebar-row-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--app-theme-focus)] disabled:cursor-not-allowed disabled:opacity-55"
                type="button" disabled={catalog.loading} aria-label={`Retry ${catalog.label} repositories`} onclick={() => onRetryEnvironmentCatalog(catalog.id)}>
                {catalog.connectionStatus === "connected" ? "Retry repositories" : "Retry connection"}
              </button>
            {/if}
          </div>
        {/if}
      {/each}
      <GroupedRepositoriesHome
        repositories={groupedRepositories}
        onOpenLocation={onOpenScopedRepository}
        onRemoveLocation={onRemoveScopedRepository}
      />
    {:else}
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

    <section class="mt-6">
      <h2 class="mb-2 text-[18px] font-medium text-[var(--app-theme-text)]">All repositories</h2>

      {#if filteredRepos.length}
        <ul class="space-y-1">
          {#each filteredRepos as repo (repo.repositoryId)}
            <li>
              <div class="group relative grid min-w-0 grid-cols-[1fr] items-center gap-2 border-b border-[var(--app-theme-border)] pr-9 transition-colors hover:bg-[var(--app-theme-sidebar-row-hover)]">
                <button
                  class="grid min-h-10 min-w-0 w-full grid-cols-[minmax(0,auto)_1fr] items-center gap-4 px-2 py-1 text-left leading-5 focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-[var(--app-theme-focus)]"
                  type="button"
                  title={repo.missing ? "Directory missing. Restore it and select this repository to retry, or remove it from GitGui." : undefined}
                  onclick={() => onOpenRepository(repo.repositoryId)}
                >
                  <span class="flex min-w-0 items-center gap-2">
                    <span class="truncate text-sm font-semibold text-[var(--app-theme-text)]">{repo.title}</span>
                    {#if repo.missing}
                      <span class="shrink-0 rounded-[2px] border border-[var(--app-theme-error-border)] bg-[var(--app-theme-error-surface)] px-1.5 text-xs font-medium leading-5 text-[var(--app-theme-error-foreground)]">Missing</span>
                    {/if}
                  </span>
                  <span class="truncate font-mono text-xs text-[var(--app-theme-text-secondary)]">{displayHostPath(repo.root)}</span>
                </button>
                <button
                  class="absolute right-1 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-[3px] text-[var(--app-theme-error-foreground)] opacity-100 transition-colors hover:bg-[var(--app-theme-error-surface)] focus-visible:outline-2 focus-visible:outline-[var(--app-theme-focus)] aria-disabled:cursor-not-allowed aria-disabled:opacity-40 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                  type="button"
                  aria-label={`Remove ${repo.title} from GitGui${!canRemoveRepository ? `. ${removeUnavailableReason}` : loading ? ". Please wait." : ""}`}
                  title={canRemoveRepository ? "Remove from GitGui (files stay on disk)" : removeUnavailableReason}
                  aria-disabled={loading || !canRemoveRepository}
                  onclick={() => { if (!loading && canRemoveRepository) void onRemoveRepository(repo.repositoryId); }}
                >
                  <X aria-hidden="true" size={16} />
                </button>
              </div>
            </li>
          {/each}
        </ul>
      {:else if repositories.length}
        <p class="py-3 text-sm text-[var(--app-theme-text-secondary)]">No repositories match your search.</p>
      {:else}
        <p class="py-3 text-sm text-[var(--app-theme-text-secondary)]">No repositories are configured on this server.</p>
      {/if}
    </section>
    {/if}
  </div>
</section>
