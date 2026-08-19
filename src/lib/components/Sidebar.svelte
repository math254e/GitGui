<script lang="ts">
  import { ChevronRight } from "@lucide/svelte";
  import type { ChangedFile, RepositorySnapshot, StashInfo } from "$lib/types/repository";

  type Props = {
    snapshot: RepositorySnapshot | null;
  };

  let { snapshot }: Props = $props();

  const emptyItems = ["No repository loaded"];

  let open = $state({
    LocalBranches: true,
    RemoteBranches: true,
    ChangedFiles: false,
    Stashes: false,
  });

  function toggle(section: keyof typeof open) {
    open[section] = !open[section];
  }

  function changedFileKey(file: ChangedFile) {
    return `${file.path}\0${file.originalPath ?? ""}\0${file.indexStatus}${file.worktreeStatus}`;
  }

  function changedFileTitle(file: ChangedFile) {
    const status = `${file.indexStatus}${file.worktreeStatus}`;
    return file.originalPath ? `${status}: ${file.originalPath} -> ${file.path}` : `${status}: ${file.path}`;
  }

  function stashKey(stash: StashInfo) {
    return `${stash.hash}\0${stash.selector}`;
  }

  function stashTitle(stash: StashInfo) {
    const branch = stash.branch ? ` on ${stash.branch}` : "";
    return `${stash.selector}${branch}: ${stash.message}\nBase: ${stash.baseHash}`;
  }
</script>

<aside class="min-h-0 border-r border-[var(--app-theme-sidebar-border)] bg-[var(--app-theme-sidebar)]">
  <div class="flex h-full flex-col overflow-auto px-4 pt-5 pb-2">
    <section class={`flex min-h-0 flex-col ${open.LocalBranches ? 'flex-1' : 'flex-none'}`}>
      <button
        type="button"
        onclick={() => toggle("LocalBranches")}
        class="group mb-3 inline-flex items-center gap-1 text-xs font-bold uppercase text-[var(--app-theme-sidebar-muted-foreground)] transition-colors hover:text-[var(--app-theme-accent-surface-foreground)]"
      >
        <ChevronRight
          aria-hidden="true"
          size={14}
          strokeWidth={2.5}
          class={`shrink-0 origin-center transition-transform duration-200 ${open.LocalBranches ? 'rotate-90' : 'rotate-0'}`}
        />
        <span>Local branches</span>
      </button>
      {#if open.LocalBranches}
        <div class="min-h-0 flex-1 overflow-auto">
          <ul class="space-y-1">
            {#if snapshot?.status.currentBranch}
              <li class="rounded-md bg-[var(--app-theme-sidebar-row-active)] px-3 py-2 text-sm font-semibold text-[var(--app-theme-accent-surface-foreground)]">
                {snapshot.status.currentBranch}
              </li>
            {:else}
              {#each emptyItems as item (item)}
                <li class="px-3 py-2 text-sm text-[var(--app-theme-text-subtle)]">{item}</li>
              {/each}
            {/if}
          </ul>
        </div>
      {/if}
    </section>

    <section class={`flex min-h-0 flex-col ${open.RemoteBranches ? 'flex-1' : 'flex-none'}`}>
      <button
        type="button"
        onclick={() => toggle("RemoteBranches")}
        class="group mb-3 inline-flex items-center gap-1 text-xs font-bold uppercase text-[var(--app-theme-sidebar-muted-foreground)] transition-colors hover:text-[var(--app-theme-accent-surface-foreground)]"
      >
        <ChevronRight
          aria-hidden="true"
          size={14}
          strokeWidth={2.5}
          class={`shrink-0 origin-center transition-transform duration-200 ${open.RemoteBranches ? 'rotate-90' : 'rotate-0'}`}
        />
        <span>Remote branches</span>
      </button>
      {#if open.RemoteBranches}
        <div class="min-h-0 flex-1 overflow-auto">
          <p class="px-3 py-2 text-sm text-[var(--app-theme-text-subtle)]">Remote refs are planned.</p>
        </div>
      {/if}
    </section>

    <section class={`flex min-h-0 flex-col ${open.ChangedFiles ? 'flex-1' : 'flex-none'}`}>
      <button
        type="button"
        onclick={() => toggle("ChangedFiles")}
        class="group mb-3 inline-flex items-center gap-1 text-xs font-bold uppercase text-[var(--app-theme-sidebar-muted-foreground)] transition-colors hover:text-[var(--app-theme-accent-surface-foreground)]"
      >
        <ChevronRight
          aria-hidden="true"
          size={14}
          strokeWidth={2.5}
          class={`shrink-0 origin-center transition-transform duration-200 ${open.ChangedFiles ? 'rotate-90' : 'rotate-0'}`}
        />
        <span>Changed files</span>
      </button>
      {#if open.ChangedFiles}
        <div class="min-h-0 flex-1 overflow-auto">
          {#if snapshot?.status.changedFiles.length}
            <ul class="space-y-1">
              {#each snapshot.status.changedFiles as file (changedFileKey(file))}
                <li
                  class="flex min-w-0 items-center gap-2 rounded-md px-3 py-2 text-sm text-[var(--app-theme-sidebar-foreground)] hover:bg-[var(--app-theme-sidebar-row-hover)]"
                  title={changedFileTitle(file)}
                >
                  <code class="shrink-0 font-mono text-xs text-[var(--app-theme-accent)]">{file.indexStatus}{file.worktreeStatus}</code>
                  <span class="truncate">{file.path}</span>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="px-3 py-2 text-sm text-[var(--app-theme-text-subtle)]">Working tree is clean.</p>
          {/if}
        </div>
      {/if}
    </section>

    <section class={`flex min-h-0 flex-col ${open.Stashes ? 'flex-1' : 'flex-none'}`}>
      <button
        type="button"
        onclick={() => toggle("Stashes")}
        class="group mb-3 inline-flex items-center gap-1 text-xs font-bold uppercase text-[var(--app-theme-sidebar-muted-foreground)] transition-colors hover:text-[var(--app-theme-accent-surface-foreground)]"
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
                  class="min-w-0 rounded-md px-3 py-2 text-sm text-[var(--app-theme-sidebar-foreground)] hover:bg-[var(--app-theme-sidebar-row-hover)]"
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
            <p class="px-3 py-2 text-sm text-[var(--app-theme-text-subtle)]">No stashes.</p>
          {/if}
        </div>
      {/if}
    </section>
  </div>
</aside>
