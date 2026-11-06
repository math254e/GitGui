<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { sameRepository, scopedRepositoryKey } from "@gitgui/client-runtime/workspace";
  import {
    RepositoryRouteController,
    type RepositoryRouteAdapter,
    type RepositoryRouteState,
  } from "$lib/workspace/repository-routing";
  import { scopedRepositoryPath, type RepositoryRouteRequest } from "$lib/workspace/routes";
  import RepositoryPage from "./RepositoryPage.svelte";

  let { request, adapter, navigate, ownsCloseNavigation = true }: {
    request: RepositoryRouteRequest | null;
    adapter: RepositoryRouteAdapter;
    navigate: (path: string, options: { replaceState: boolean }) => void;
    /** The transition store already navigates after close. Integrated routes own replacement. */
    ownsCloseNavigation?: boolean;
  } = $props();
  let state = $state<RepositoryRouteState>({ kind: "loading" });
  const controller = new RepositoryRouteController(
    { activate: (target, options) => adapter.activate(target, options) },
    (next) => { state = next; },
    (target) => {
      if (ownsCloseNavigation) navigate(target ? scopedRepositoryPath(target.environmentId, target.repositoryId) : "/", { replaceState: true });
    },
  );
  const snapshot = $derived(adapter.snapshot);
  $effect(() => {
    const input = request;
    const current = snapshot;
    untrack(() => controller.update(input, current));
  });
  onDestroy(() => controller.dispose());
</script>

{#if state.kind === "ready" && snapshot.view && snapshot.activeTarget && sameRepository(state.target, snapshot.activeTarget)}
  {#key scopedRepositoryKey(state.target)}
    <RepositoryPage store={snapshot.view} />
  {/key}
{:else}
  <div class="flex h-full flex-col items-center justify-center gap-3 overflow-auto p-8 text-[var(--app-theme-text)]">
    {#if state.kind === "ambiguous"}
      <h1 class="text-lg font-medium">Choose a repository location</h1>
      <p class="text-sm text-[var(--app-theme-text-muted)]">This repository ID exists in more than one environment.</p>
      <ul class="flex max-w-full flex-col gap-2">
        {#each state.candidates as candidate (scopedRepositoryKey(candidate.target))}
          <li>
            <button
              class="max-w-full rounded border border-[var(--app-theme-border)] px-4 py-2 text-left hover:bg-[var(--app-theme-sidebar-row-hover)]"
              onclick={() => navigate(scopedRepositoryPath(candidate.target.environmentId, candidate.target.repositoryId), { replaceState: true })}
            >
              <span class="block">{candidate.environmentLabel}</span>
              <span class="block break-all text-xs text-[var(--app-theme-text-muted)]">{candidate.path || candidate.target.repositoryId}</span>
              <span class="block break-all text-xs text-[var(--app-theme-text-muted)]">{candidate.target.environmentId}</span>
            </button>
          </li>
        {/each}
      </ul>
    {:else if state.kind === "missing" || state.kind === "error"}
      <p role="alert">{state.message}</p>
      {#if state.kind === "error"}
        <button class="rounded border border-[var(--app-theme-border)] px-3 py-1" onclick={() => controller.retry()}>Retry</button>
      {/if}
      <button class="rounded border border-[var(--app-theme-border)] px-3 py-1" onclick={() => navigate("/", { replaceState: true })}>Repositories</button>
    {:else}
      <p role="status" class="text-sm text-[var(--app-theme-text-muted)]">{state.kind === "closed" ? "Repository tab closed." : "Loading repository…"}</p>
    {/if}
  </div>
{/if}
