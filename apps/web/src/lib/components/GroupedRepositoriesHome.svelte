<script lang="ts">
  import { displayHostPath } from "$lib/display-host-path";
  export interface GroupedRepositoryTarget {
    readonly environmentId: string;
    readonly repositoryId: string;
  }

  export interface GroupedRepositoryLocation {
    readonly target: GroupedRepositoryTarget;
    readonly environmentLabel: string;
    readonly local?: boolean;
    readonly environmentStatus?: "connected" | "offline" | "connecting" | "blocked" | string;
    readonly path: string;
    readonly missing?: boolean;
    readonly removeAvailability?: { readonly allowed: boolean; readonly reason: string };
  }

  export interface GroupedRepository {
    readonly groupId: string;
    readonly title: string;
    readonly locations: readonly GroupedRepositoryLocation[];
  }

  let {
    repositories,
    onOpenLocation,
    onRemoveLocation,
  }: {
    repositories: readonly GroupedRepository[];
    onOpenLocation: (target: GroupedRepositoryTarget) => void;
    onRemoveLocation?: (target: GroupedRepositoryTarget) => void | Promise<void>;
  } = $props();

  let search = $state("");
  let expanded = $state<Record<string, boolean>>({});

  const filteredRepositories = $derived.by(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return repositories;
    return repositories.filter((repository) =>
      repository.title.toLocaleLowerCase().includes(query)
      || repository.locations.some((location) =>
        location.path.toLocaleLowerCase().includes(query)
        || displayHostPath(location.path).toLocaleLowerCase().includes(query)
        || location.environmentLabel.toLocaleLowerCase().includes(query),
      ),
    );
  });

  function locationsByEnvironment(repository: GroupedRepository) {
    const environments = new Map<string, GroupedRepositoryLocation[]>();
    for (const location of repository.locations) {
      const current = environments.get(location.target.environmentId) ?? [];
      current.push(location);
      environments.set(location.target.environmentId, current);
    }
    return [...environments.entries()].map(([environmentId, locations]) => ({
      environmentId,
      label: locations[0].local ? "Local" : locations[0].environmentLabel,
      status: locations[0].environmentStatus,
      locations,
    }));
  }

  function statusLabel(status: string | undefined) {
    if (!status || status === "connected") return "";
    return status === "offline" ? "Offline" : status === "connecting" ? "Connecting" : status === "blocked" ? "Needs attention" : status;
  }

  function locationLabel(repository: GroupedRepository, location: GroupedRepositoryLocation) {
    const state = location.missing ? ", Missing" : statusLabel(location.environmentStatus) ? `, ${statusLabel(location.environmentStatus)}` : "";
    return `${repository.title}, ${location.local ? "Local" : location.environmentLabel}, ${displayHostPath(location.path)}${state}`;
  }

  function disclosureId(groupId: string, environmentId: string) {
    return `grouped-repository-${encodeURIComponent(groupId)}-${encodeURIComponent(environmentId)}`;
  }
</script>

<div class="relative mt-4">
  <svg aria-hidden="true" class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[var(--app-theme-text-muted)]" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
    <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
  </svg>
  <label class="sr-only" for="grouped-repository-search">Search repositories</label>
  <input
    id="grouped-repository-search"
    class="h-9 w-full rounded-[3px] border border-[var(--app-theme-input)] bg-[var(--app-theme-surface)] pr-3 pl-8 text-sm text-[var(--app-theme-text)] outline-none placeholder:text-[var(--app-theme-text-muted)] focus:border-[var(--app-theme-focus)] focus:ring-2 focus:ring-[var(--app-theme-focus-ring)]"
    bind:value={search}
    placeholder="Search repositories"
  />
</div>

<section class="mt-5" aria-label="All repositories">
  <div class="mb-1 flex items-center justify-between gap-3 border-b border-[var(--app-theme-border)] pb-2">
    <h2 class="text-sm font-semibold text-[var(--app-theme-text)]">All repositories</h2>
    <span class="text-xs text-[var(--app-theme-text-secondary)]" aria-live="polite">{filteredRepositories.length} {filteredRepositories.length === 1 ? "repository" : "repositories"}</span>
  </div>

  {#if filteredRepositories.length}
    <ul>
      {#each filteredRepositories as repository (repository.groupId)}
        <li class="min-w-0 border-b border-[var(--app-theme-border)] py-2">
          <div class="flex min-w-0 items-center gap-2 px-2">
            <h3 class="min-w-0 truncate text-sm font-semibold text-[var(--app-theme-text)]">{repository.title}</h3>
            {#if repository.locations.length > 1}
              <span class="shrink-0 text-xs text-[var(--app-theme-text-secondary)]">{repository.locations.length} locations</span>
            {/if}
          </div>

          {#if repository.locations.length === 1}
            {@const location = repository.locations[0]}
              <div class="group relative flex min-w-0 items-center pr-9">
              <button
                class="flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-[3px] px-2 text-left text-sm text-[var(--app-theme-text-secondary)] hover:bg-[var(--app-theme-sidebar-row-hover)] hover:text-[var(--app-theme-text)] focus-visible:outline-2 focus-visible:outline-[var(--app-theme-focus)]"
                type="button"
                title={displayHostPath(location.path)}
                aria-label={locationLabel(repository, location)}
                onclick={() => onOpenLocation(location.target)}
              >
                {#if !location.local}<span class="shrink-0 text-[var(--app-theme-text)]">{location.environmentLabel}</span>{/if}
                <span class="min-w-0 flex-1 truncate" title={displayHostPath(location.path)}>{displayHostPath(location.path)}</span>
                {#if location.missing}
                  <span class="shrink-0 rounded-[2px] border border-[var(--app-theme-error-border)] bg-[var(--app-theme-error-surface)] px-1.5 text-xs font-medium leading-5 text-[var(--app-theme-error-foreground)]">Missing</span>
                {/if}
                {#if statusLabel(location.environmentStatus)}
                  <span class="shrink-0 text-xs font-medium text-[var(--app-theme-text-secondary)]">{statusLabel(location.environmentStatus)}</span>
                {/if}
              </button>
              {#if onRemoveLocation}
                <button
                  class="absolute right-1 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-[3px] text-[var(--app-theme-error-foreground)] opacity-100 transition-colors hover:bg-[var(--app-theme-error-surface)] focus-visible:outline-2 focus-visible:outline-[var(--app-theme-focus)] aria-disabled:cursor-not-allowed aria-disabled:opacity-40 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                  type="button"
                  aria-label={`Remove ${repository.title} at ${displayHostPath(location.path)} from GitGui${location.removeAvailability?.allowed ? "" : `. ${location.removeAvailability?.reason || "Session authorization is unavailable."}`}`}
                  title={location.removeAvailability?.allowed ? "Remove from GitGui (files stay on disk)" : location.removeAvailability?.reason || "Session authorization is unavailable."}
                  aria-disabled={location.removeAvailability?.allowed !== true}
                  onclick={() => { if (location.removeAvailability?.allowed === true) void onRemoveLocation(location.target); }}
                ><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m18 6-12 12M6 6l12 12" /></svg></button>
              {/if}
            </div>
          {:else}
            <ul class="mt-0.5">
              {#each locationsByEnvironment(repository) as environment (environment.environmentId)}
                {#if environment.locations.length > 1}
                  <li>
                    <details open={expanded[disclosureId(repository.groupId, environment.environmentId)] ?? false} ontoggle={(event) => {
                      const element = event.currentTarget as HTMLDetailsElement;
                      expanded = { ...expanded, [disclosureId(repository.groupId, environment.environmentId)]: element.open };
                    }}>
                      <summary
                        class="flex min-h-8 cursor-pointer list-none items-center gap-2 rounded-[3px] px-2 text-sm text-[var(--app-theme-text-secondary)] hover:bg-[var(--app-theme-sidebar-row-hover)] focus-visible:outline-2 focus-visible:outline-[var(--app-theme-focus)] [&::-webkit-details-marker]:hidden"
                        aria-controls={disclosureId(repository.groupId, environment.environmentId)}
                      >
                        <svg aria-hidden="true" class={`h-3 w-3 shrink-0 text-[var(--app-theme-text-secondary)] transition-transform ${expanded[disclosureId(repository.groupId, environment.environmentId)] ? "rotate-90" : ""}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75"><path d="m5 3 5 5-5 5" /></svg>
                        <span class="min-w-0 flex-1 truncate text-[var(--app-theme-text)]">{environment.label}</span>
                        <span class="text-xs text-[var(--app-theme-text-secondary)]">{environment.locations.length} locations</span>
                        {#if statusLabel(environment.status)}<span class="text-xs text-[var(--app-theme-text-secondary)]">{statusLabel(environment.status)}</span>{/if}
                      </summary>
                      <ul id={disclosureId(repository.groupId, environment.environmentId)} class="ml-5 border-l border-[var(--app-theme-border)] pl-2">
                        {#each environment.locations as location (location.target.repositoryId)}
                          <li class="group relative flex min-w-0 items-center pr-8">
                            <button
                              class="flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-[3px] px-2 text-left text-sm text-[var(--app-theme-text-secondary)] hover:bg-[var(--app-theme-sidebar-row-hover)] hover:text-[var(--app-theme-text)] focus-visible:outline-2 focus-visible:outline-[var(--app-theme-focus)]"
                              type="button"
                              title={displayHostPath(location.path)}
                              aria-label={locationLabel(repository, location)}
                              onclick={() => onOpenLocation(location.target)}
                            >
                              <span class="min-w-0 flex-1 truncate">{displayHostPath(location.path)}</span>
                              {#if location.missing}
                                <span class="shrink-0 rounded-[2px] border border-[var(--app-theme-error-border)] bg-[var(--app-theme-error-surface)] px-1.5 text-xs font-medium leading-5 text-[var(--app-theme-error-foreground)]">Missing</span>
                              {/if}
                              {#if statusLabel(location.environmentStatus)}
                                <span class="shrink-0 text-xs font-medium text-[var(--app-theme-text-secondary)]">{statusLabel(location.environmentStatus)}</span>
                              {/if}
                            </button>
                            {#if onRemoveLocation}
                              <button
                                class="absolute right-1 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-[3px] text-[var(--app-theme-error-foreground)] opacity-100 transition-colors hover:bg-[var(--app-theme-error-surface)] focus-visible:outline-2 focus-visible:outline-[var(--app-theme-focus)] aria-disabled:cursor-not-allowed aria-disabled:opacity-40 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                                type="button"
                                aria-label={`Remove ${repository.title} at ${displayHostPath(location.path)} from GitGui${location.removeAvailability?.allowed ? "" : `. ${location.removeAvailability?.reason || "Session authorization is unavailable."}`}`}
                                title={location.removeAvailability?.allowed ? "Remove from GitGui (files stay on disk)" : location.removeAvailability?.reason || "Session authorization is unavailable."}
                                aria-disabled={location.removeAvailability?.allowed !== true}
                                onclick={() => { if (location.removeAvailability?.allowed === true) void onRemoveLocation(location.target); }}
                              ><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m18 6-12 12M6 6l12 12" /></svg></button>
                            {/if}
                          </li>
                        {/each}
                      </ul>
                    </details>
                  </li>
                {:else}
                  {@const location = environment.locations[0]}
                  <li class="group relative flex min-w-0 items-center pr-8">
                    <button
                      class="flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-[3px] px-2 text-left text-sm text-[var(--app-theme-text-secondary)] hover:bg-[var(--app-theme-sidebar-row-hover)] hover:text-[var(--app-theme-text)] focus-visible:outline-2 focus-visible:outline-[var(--app-theme-focus)]"
                      type="button"
                      title={displayHostPath(location.path)}
                      aria-label={locationLabel(repository, location)}
                      onclick={() => onOpenLocation(location.target)}
                    >
                      {#if !location.local}<span class="shrink-0 text-[var(--app-theme-text)]">{environment.label}</span>{/if}
                      <span class="min-w-0 flex-1 truncate">{displayHostPath(location.path)}</span>
                      {#if location.missing}
                        <span class="shrink-0 rounded-[2px] border border-[var(--app-theme-error-border)] bg-[var(--app-theme-error-surface)] px-1.5 text-xs font-medium leading-5 text-[var(--app-theme-error-foreground)]">Missing</span>
                      {/if}
                      {#if statusLabel(location.environmentStatus)}
                        <span class="shrink-0 text-xs font-medium text-[var(--app-theme-text-secondary)]">{statusLabel(location.environmentStatus)}</span>
                      {/if}
                    </button>
                    {#if onRemoveLocation}
                      <button
                        class="absolute right-1 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-[3px] text-[var(--app-theme-error-foreground)] opacity-100 transition-colors hover:bg-[var(--app-theme-error-surface)] focus-visible:outline-2 focus-visible:outline-[var(--app-theme-focus)] aria-disabled:cursor-not-allowed aria-disabled:opacity-40 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                        type="button"
                        aria-label={`Remove ${repository.title} at ${displayHostPath(location.path)} from GitGui${location.removeAvailability?.allowed ? "" : `. ${location.removeAvailability?.reason || "Session authorization is unavailable."}`}`}
                        title={location.removeAvailability?.allowed ? "Remove from GitGui (files stay on disk)" : location.removeAvailability?.reason || "Session authorization is unavailable."}
                        aria-disabled={location.removeAvailability?.allowed !== true}
                        onclick={() => { if (location.removeAvailability?.allowed === true) void onRemoveLocation(location.target); }}
                      ><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m18 6-12 12M6 6l12 12" /></svg></button>
                    {/if}
                  </li>
                {/if}
              {/each}
            </ul>
          {/if}
        </li>
      {/each}
    </ul>
  {:else if repositories.length}
    <p class="py-1 text-sm text-[var(--app-theme-text-secondary)]">No repositories match your search.</p>
  {:else}
    <p class="py-1 text-sm text-[var(--app-theme-text-secondary)]">No repositories are available.</p>
  {/if}
</section>
