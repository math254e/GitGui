<script lang="ts" module>
  export type RepoTab = {
    id: string;
    title: string;
    root: string;
    branch: string;
    error: string;
  };
</script>

<script lang="ts">
  import { Home, Settings, X } from "@lucide/svelte";

  type Props = {
    activeView: "start" | "repo" | "settings" | "create";
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

  <div class="flex h-full min-w-0 flex-1 items-stretch overflow-x-auto" aria-label="Open repositories" role="tablist">
    {#if tabs.length}
      {#each tabs as tab (tab.id)}
        <div
          class={`group flex h-full min-w-36 max-w-64 items-center border-r border-[var(--app-theme-toolbar-border)] transition ${
            activeView === "repo" && activeRepoId === tab.id
              ? "bg-[var(--app-theme-toolbar-control-hover)] text-[var(--app-theme-text)]"
              : "bg-[var(--app-theme-toolbar)] text-[var(--app-theme-toolbar-foreground)] hover:bg-[var(--app-theme-toolbar-control-hover)]"
          }`}
          role="tab"
          aria-selected={activeView === "repo" && activeRepoId === tab.id}
          tabindex={activeView === "repo" && activeRepoId === tab.id ? 0 : -1}
          title={`${tab.root} (${tab.branch})`}
          onclick={() => onSelectRepo(tab.id)}
          onkeydown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSelectRepo(tab.id);
            }
          }}
        >
          <div class="flex h-full min-w-0 flex-1 items-center gap-2 px-3 text-left">
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-semibold">{tab.title}</span>
              <span class={`block truncate text-xs ${tab.error ? "text-[var(--app-theme-error)]" : "text-[var(--app-theme-text-subtle)]"}`}>
                {tab.error || tab.branch}
              </span>
            </span>
          </div>
          <button
            class="mr-2 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--app-theme-text-muted)] transition hover:bg-[var(--app-theme-control-hover)] hover:text-[var(--app-theme-text)]"
            type="button"
            aria-label={`Close ${tab.title}`}
            title={`Close ${tab.title}`}
            onclick={(event) => {
              event.stopPropagation();
              onCloseRepo(tab.id);
            }}
          >
            <X aria-hidden="true" size={14} />
          </button>
        </div>
      {/each}
    {:else}
      <div class="flex h-full items-center px-4 text-sm text-[var(--app-theme-text-subtle)]">No repositories open</div>
    {/if}
  </div>

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
