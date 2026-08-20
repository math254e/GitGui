<script lang="ts">
  import { ChevronRight } from "@lucide/svelte";
  import BranchTree from "$lib/components/BranchTree.svelte";
  import type { CommitInfo, CommitRef, RepositorySnapshot, StashInfo } from "$lib/types/repository";

  type Props = {
    snapshot: RepositorySnapshot | null;
    selectedCommit: CommitInfo | null;
    stateKey: string | null;
    visibleRefKeys?: ReadonlySet<string>;
    onSelectRef?: (ref: CommitRef) => void;
    onToggleRefs?: (refs: CommitRef[], visible: boolean) => void;
  };

  type SidebarSections = {
    LocalBranches: boolean;
    RemoteBranches: boolean;
    Stashes: boolean;
  };

  const sidebarStateStoragePrefix = "gitgui.sidebarSections.v1";
  const defaultOpen: SidebarSections = {
    LocalBranches: true,
    RemoteBranches: true,
    Stashes: false,
  };

  let {
    snapshot,
    selectedCommit,
    stateKey,
    visibleRefKeys = new Set<string>(),
    onSelectRef,
    onToggleRefs,
  }: Props = $props();

  let open = $state<SidebarSections>({ ...defaultOpen });
  let loadedStateKey = $state<string | null | undefined>(undefined);

  const localBranches = $derived(snapshot?.refs.filter((ref) => ref.refType === "localBranch") ?? []);
  const remoteBranches = $derived(snapshot?.refs.filter((ref) => ref.refType === "remoteBranch") ?? []);

  function toggle(section: keyof typeof open) {
    open[section] = !open[section];
    persistOpenState();
  }

  function stashKey(stash: StashInfo) {
    return `${stash.hash}\0${stash.selector}`;
  }

  function stashTitle(stash: StashInfo) {
    const branch = stash.branch ? ` on ${stash.branch}` : "";
    return `${stash.selector}${branch}: ${stash.message}\nBase: ${stash.baseHash}`;
  }

  $effect(() => {
    if (stateKey === loadedStateKey) {
      return;
    }

    loadedStateKey = stateKey;
    open = stateKey ? readOpenState(stateKey) : { ...defaultOpen };
  });

  function handleSelectRef(ref: CommitRef) {
    onSelectRef?.(ref);
  }

  function storageKey(key: string) {
    return `${sidebarStateStoragePrefix}:${encodeURIComponent(key)}`;
  }

  function readOpenState(key: string): SidebarSections {
    const fallback = { ...defaultOpen };

    try {
      const stored = localStorage.getItem(storageKey(key));
      if (!stored) {
        return fallback;
      }

      const parsed: unknown = JSON.parse(stored);
      if (!parsed || typeof parsed !== "object") {
        return fallback;
      }

      const value = parsed as Partial<Record<keyof SidebarSections, unknown>>;
      return {
        LocalBranches: typeof value.LocalBranches === "boolean" ? value.LocalBranches : fallback.LocalBranches,
        RemoteBranches: typeof value.RemoteBranches === "boolean" ? value.RemoteBranches : fallback.RemoteBranches,
        Stashes: typeof value.Stashes === "boolean" ? value.Stashes : fallback.Stashes,
      };
    } catch {
      return fallback;
    }
  }

  function persistOpenState() {
    if (!stateKey) {
      return;
    }

    try {
      localStorage.setItem(storageKey(stateKey), JSON.stringify(open));
    } catch {
      // Sidebar preferences are best-effort and must not affect repository UI.
    }
  }
</script>

<aside class="min-h-0 border-r border-[var(--app-theme-sidebar-border)] bg-[var(--app-theme-sidebar)]">
  <div class="flex h-full flex-col overflow-auto px-2 pt-1 pb-1">
    <section class={`flex min-h-0 flex-col border-b border-[var(--app-theme-sidebar-border)] py-2 first:pt-2 last:border-b-0 ${open.LocalBranches ? 'flex-1' : 'flex-none'}`}>
      <button
        type="button"
        onclick={() => toggle("LocalBranches")}
        class="group mb-1 inline-flex items-center gap-1 text-xs font-bold uppercase text-[var(--app-theme-sidebar-muted-foreground)] transition-colors hover:text-[var(--app-theme-accent-surface-foreground)]"
      >
        <ChevronRight
          aria-hidden="true"
          size={14}
          strokeWidth={2.5}
          class={`shrink-0 origin-center transition-transform duration-200 ${open.LocalBranches ? 'rotate-90' : 'rotate-0'}`}
        />
        <span>Local branches {snapshot ? `(${localBranches.length})` : ""}</span>
      </button>
      {#if open.LocalBranches}
        <div class="min-h-0 flex-1 overflow-auto">
          {#if localBranches.length}
            <BranchTree
              refs={localBranches}
              refType="localBranch"
              treeId="gitgui-local-branches"
              currentBranch={snapshot?.status.currentBranch}
              selectedCommitHash={selectedCommit?.hash ?? null}
              {visibleRefKeys}
              onSelectRef={handleSelectRef}
              {onToggleRefs}
            />
          {:else}
            <p class="px-2 py-1 text-sm text-[var(--app-theme-text-subtle)]">No local branches.</p>
          {/if}
        </div>
      {/if}
    </section>

    <section class={`flex min-h-0 flex-col border-b border-[var(--app-theme-sidebar-border)] py-2 last:border-b-0 ${open.RemoteBranches ? 'flex-1' : 'flex-none'}`}>
      <button
        type="button"
        onclick={() => toggle("RemoteBranches")}
        class="group mb-1 inline-flex items-center gap-1 text-xs font-bold uppercase text-[var(--app-theme-sidebar-muted-foreground)] transition-colors hover:text-[var(--app-theme-accent-surface-foreground)]"
      >
        <ChevronRight
          aria-hidden="true"
          size={14}
          strokeWidth={2.5}
          class={`shrink-0 origin-center transition-transform duration-200 ${open.RemoteBranches ? 'rotate-90' : 'rotate-0'}`}
        />
        <span>Remote branches {snapshot ? `(${remoteBranches.length})` : ""}</span>
      </button>
      {#if open.RemoteBranches}
        <div class="min-h-0 flex-1 overflow-auto">
          {#if remoteBranches.length}
            <BranchTree
              refs={remoteBranches}
              refType="remoteBranch"
              treeId="gitgui-remote-branches"
              selectedCommitHash={selectedCommit?.hash ?? null}
              {visibleRefKeys}
              onSelectRef={handleSelectRef}
              {onToggleRefs}
            />
          {:else}
            <p class="px-2 py-1 text-sm text-[var(--app-theme-text-subtle)]">No remote branches.</p>
          {/if}
        </div>
      {/if}
    </section>

    <section class={`flex min-h-0 flex-col border-b border-[var(--app-theme-sidebar-border)] py-2 last:border-b-0 ${open.Stashes ? 'flex-1' : 'flex-none'}`}>
      <button
        type="button"
        onclick={() => toggle("Stashes")}
        class="group mb-1 inline-flex items-center gap-1 text-xs font-bold uppercase text-[var(--app-theme-sidebar-muted-foreground)] transition-colors hover:text-[var(--app-theme-accent-surface-foreground)]"
      >
        <ChevronRight
          aria-hidden="true"
          size={14}
          strokeWidth={2.5}
          class={`shrink-0 origin-center transition-transform duration-200 ${open.Stashes ? 'rotate-90' : 'rotate-0'}`}
        />
        <span>Stashes {snapshot ? `(${(snapshot.stashes ?? []).length})` : ""}</span>
      </button>
      {#if open.Stashes}
        <div class="min-h-0 flex-1 overflow-auto">
          {#if snapshot?.stashes?.length}
            <ul class="space-y-1">
              {#each snapshot.stashes ?? [] as stash (stashKey(stash))}
                <li
                  class="min-w-0 rounded-md px-2 py-1 text-sm text-[var(--app-theme-sidebar-foreground)] hover:bg-[var(--app-theme-sidebar-row-hover)]"
                  title={stashTitle(stash)}
                >
                  <div class="flex min-w-0 items-center gap-2">
                    <code class="shrink-0 font-mono text-xs text-[var(--app-theme-accent)]">{stash.selector}</code>
                    <span class="truncate">{stash.message}</span>
                  </div>
                  {#if stash.branch}
                    <span class="mt-0.5 block truncate pl-[4.5rem] text-xs text-[var(--app-theme-text-subtle)]">on {stash.branch}</span>
                  {/if}
                </li>
              {/each}
            </ul>
          {:else}
            <p class="px-2 py-1 text-sm text-[var(--app-theme-text-subtle)]">No stashes.</p>
          {/if}
        </div>
      {/if}
    </section>
  </div>
</aside>
