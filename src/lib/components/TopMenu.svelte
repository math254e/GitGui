<script lang="ts" module>
  export type RepoTab = {
    id: string;
    title: string;
    root: string;
    branch: string;
    loading: boolean;
    error: string;
  };
</script>

<script lang="ts">
  import { Home, Settings, X } from "@lucide/svelte";

  type Props = {
    activeView: "start" | "repo" | "settings";
    activeRepoId: string | null;
    tabs: RepoTab[];
    onShowStart: () => void;
    onShowSettings: () => void;
    onSelectRepo: (repoId: string) => void;
    onCloseRepo: (repoId: string) => void;
  };

  let { activeView, activeRepoId, tabs, onShowStart, onShowSettings, onSelectRepo, onCloseRepo }: Props = $props();
</script>

<header class="flex h-12 min-h-12 items-center border-b border-[var(--app-theme-toolbar-border)] bg-[var(--app-theme-toolbar)]">
  <button
    class={`flex h-full w-12 shrink-0 items-center justify-center border-r border-[var(--app-theme-toolbar-border)] transition ${
      activeView === "start"
        ? "bg-[var(--app-theme-accent-surface)] text-[var(--app-theme-accent-surface-foreground)]"
        : "text-[var(--app-theme-toolbar-foreground)] hover:bg-[var(--app-theme-toolbar-control-hover)]"
    }`}
    type="button"
    aria-label="Start view"
    title="Start"
    onclick={onShowStart}
  >
    <Home aria-hidden="true" size={18} />
  </button>

  <nav class="flex h-full min-w-0 flex-1 items-stretch overflow-x-auto" aria-label="Open repositories">
    {#if tabs.length}
      {#each tabs as tab (tab.id)}
        <div
          class={`group flex h-full min-w-36 max-w-64 items-center border-r border-[var(--app-theme-toolbar-border)] transition ${
            activeView === "repo" && activeRepoId === tab.id
              ? "bg-[var(--app-theme-toolbar-control-hover)] text-[var(--app-theme-text)]"
              : "bg-[var(--app-theme-toolbar)] text-[var(--app-theme-toolbar-foreground)] hover:bg-[var(--app-theme-toolbar-control-hover)]"
          }`}
          title={`${tab.root} (${tab.branch})`}
        >
          <button
            class="flex h-full min-w-0 flex-1 items-center gap-2 px-3 text-left"
            type="button"
            onclick={() => onSelectRepo(tab.id)}
          >
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-semibold">{tab.title}</span>
              <span class={`block truncate text-xs ${tab.error ? "text-[var(--app-theme-error)]" : "text-[var(--app-theme-text-subtle)]"}`}>
                {tab.error || tab.branch}
              </span>
            </span>
            {#if tab.loading}
              <span class="h-2 w-2 shrink-0 rounded-full bg-[var(--app-theme-success)]" aria-label="Loading"></span>
            {/if}
          </button>
          <button
            class="mr-2 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--app-theme-text-muted)] transition hover:bg-[var(--app-theme-control-hover)] hover:text-[var(--app-theme-text)]"
            type="button"
            aria-label={`Close ${tab.title}`}
            title={`Close ${tab.title}`}
            onclick={() => onCloseRepo(tab.id)}
          >
            <X aria-hidden="true" size={14} />
          </button>
        </div>
      {/each}
    {:else}
      <div class="flex h-full items-center px-4 text-sm text-[var(--app-theme-text-subtle)]">No repositories open</div>
    {/if}
  </nav>

  <button
    class={`flex h-full w-12 shrink-0 items-center justify-center border-l border-[var(--app-theme-toolbar-border)] transition ${
      activeView === "settings"
        ? "bg-[var(--app-theme-accent-surface)] text-[var(--app-theme-accent-surface-foreground)]"
        : "text-[var(--app-theme-toolbar-foreground)] hover:bg-[var(--app-theme-toolbar-control-hover)]"
    }`}
    type="button"
    aria-label="Settings"
    title="Settings"
    onclick={onShowSettings}
  >
    <Settings aria-hidden="true" size={18} />
  </button>
</header>
