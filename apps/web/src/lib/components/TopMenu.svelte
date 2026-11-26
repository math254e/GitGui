<script lang="ts" module>
  export type RepoTab = {
    id: string;
    title: string;
    root: string;
    isWorktree: boolean;
    branch: string;
    error: string;
  };
</script>

<script lang="ts">
  import { Home, Settings, TreeDeciduous, X } from "@lucide/svelte";
  import { displayHostPath } from "$lib/display-host-path";
  import DesktopUpdateControl from "$lib/updates/DesktopUpdateControl.svelte";

  type Props = {
    activeView: "start" | "repo" | "settings" | "create";
    activeRepoId: string | null;
    tabs: RepoTab[];
    onShowStart: () => void;
    onShowSettings: () => void;
    onSelectRepo: (repoId: string) => void;
    onCloseRepo: (repoId: string) => void;
    onMoveRepo: (repoId: string, targetId: string, side: "before" | "after") => void;
  };

  let { activeView, activeRepoId, tabs, onShowStart, onShowSettings, onSelectRepo, onCloseRepo, onMoveRepo }: Props = $props();
  let draggedId = $state<string | null>(null);
  // A boundary belongs to the gap, not to either of its neighboring tabs.
  let dropBoundary = $state<number | null>(null);

  function dragOver(event: DragEvent, index: number) {
    if (!draggedId) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    dropBoundary = index + (event.clientX < rect.left + rect.width / 2 ? 0 : 1);
  }

  function finishDrag() { draggedId = null; dropBoundary = null; }

  function drop(event: DragEvent) {
    if (!draggedId || dropBoundary === null || !tabs.length) return;
    event.preventDefault();
    const target = tabs[dropBoundary] ?? tabs[tabs.length - 1];
    onMoveRepo(draggedId, target.id, dropBoundary < tabs.length ? "before" : "after");
    finishDrag();
  }

  function navigationStateClasses(active: boolean): string {
    return active
      ? "bg-[var(--app-theme-sidebar)] text-[var(--app-theme-sidebar-foreground)]"
      : "bg-[var(--app-theme-toolbar)] text-[var(--app-theme-text-muted)] hover:bg-[var(--app-theme-toolbar-control-hover)] hover:text-[var(--app-theme-text)]";
  }

  function navigateTabs(event: KeyboardEvent, index: number) {
    const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
      : event.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length
      : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const tab = event.currentTarget as HTMLElement;
    (tab.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]')[next])?.focus();
    onSelectRepo(tabs[next].id);
  }
</script>

<header class="flex h-12 min-h-12 items-center border-b border-[var(--app-theme-toolbar-border-subtle)] bg-[var(--app-theme-toolbar)]">
  <button
    class={`flex h-full w-12 shrink-0 items-center justify-center border-r border-[var(--app-theme-toolbar-border-subtle)] transition ${navigationStateClasses(activeView === "start")}`}
    type="button"
    aria-label="Start view"
    aria-current={activeView === "start" ? "page" : undefined}
    title="Start"
    onclick={onShowStart}
  >
    <Home aria-hidden="true" size={18} />
  </button>

  <div
    class="flex h-full min-w-0 flex-1 items-stretch overflow-x-auto"
    aria-label="Open repositories"
    role="tablist"
    tabindex="-1"
    ondragover={(event) => {
      if (event.target !== event.currentTarget || !draggedId || !tabs.length) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      dropBoundary = tabs.length;
    }}
    ondragleave={(event) => {
      if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) dropBoundary = null;
    }}
    ondrop={drop}
  >
    {#if tabs.length}
      {#each tabs as tab, index (tab.id)}
        {@const active = activeView === "repo" && activeRepoId === tab.id}
        {#if dropBoundary === index}
          <span aria-hidden="true" class="pointer-events-none relative z-20 h-full w-0 shrink-0"><span class="absolute inset-y-0 left-0 w-0.5 -translate-x-1/2 bg-[var(--app-theme-text)]"></span></span>
        {/if}
        <div
          class={`group relative flex h-full min-w-36 max-w-64 items-center border-r border-[var(--app-theme-toolbar-border-subtle)] transition ${navigationStateClasses(active)} ${draggedId === tab.id ? "opacity-50" : ""}`}
          role="tab"
          draggable="true"
          aria-selected={active}
          tabindex={activeRepoId === tab.id || (!tabs.some((entry) => entry.id === activeRepoId) && index === 0) ? 0 : -1}
          title={`${tab.branch ? `${displayHostPath(tab.root)} (${tab.branch})` : displayHostPath(tab.root)}\nDrag to reorder, or use Alt+Shift+Arrow keys`}
          onclick={() => onSelectRepo(tab.id)}
          ondragstart={(event) => {
            if ((event.target as HTMLElement).closest("button")) { event.preventDefault(); return; }
            draggedId = tab.id;
            event.dataTransfer?.setData("text/plain", tab.id);
            if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
          }}
          ondragover={(event) => dragOver(event, index)}
          ondragend={finishDrag}
          onkeydown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.altKey && event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
              event.preventDefault();
              const next = index + (event.key === "ArrowLeft" ? -1 : 1);
              if (tabs[next]) onMoveRepo(tab.id, tabs[next].id, event.key === "ArrowLeft" ? "before" : "after");
              return;
            }
            navigateTabs(event, index);
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSelectRepo(tab.id);
            }
          }}
        >
          <div class="flex h-full min-w-0 flex-1 items-center gap-2 px-3 text-left">
            <span class="min-w-0 flex-1">
              <span class="flex min-w-0 items-center gap-1.5 truncate text-sm font-semibold">
                {#if tab.isWorktree}
                  <TreeDeciduous aria-hidden="true" class={`shrink-0 ${active ? "text-[var(--app-theme-sidebar-foreground)] opacity-75" : "text-[var(--app-theme-text-muted)]"}`} size={14} />
                {/if}
                <span class="truncate">{tab.title}</span>
              </span>
              <span class={`block truncate text-xs font-normal ${tab.error ? "text-[var(--app-theme-error)]" : "text-[var(--app-theme-text-subtle)]"}`}>
                {tab.error || tab.branch}
              </span>
            </span>
          </div>
          <button
            class={`mr-2 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm ${active ? "text-[var(--app-theme-sidebar-foreground)]" : "text-[var(--app-theme-text-muted)]"} opacity-60 transition-colors group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-[var(--app-theme-control-hover)] hover:text-[var(--app-theme-text)]`}
            type="button"
            aria-label={`Close ${tab.title}${tab.root ? `, ${displayHostPath(tab.root)}` : ""}${tab.branch ? `, ${tab.branch}` : ""}`}
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
      {#if dropBoundary === tabs.length}
        <span aria-hidden="true" class="pointer-events-none relative z-20 h-full w-0 shrink-0"><span class="absolute inset-y-0 left-0 w-0.5 -translate-x-1/2 bg-[var(--app-theme-text)]"></span></span>
      {/if}
    {:else}
      <div class="flex h-full items-center px-4 text-sm text-[var(--app-theme-text-subtle)]">No repositories open</div>
    {/if}
  </div>

  <DesktopUpdateControl />
  <button
    class={`flex h-full w-12 shrink-0 items-center justify-center border-l border-[var(--app-theme-toolbar-border-subtle)] transition ${navigationStateClasses(activeView === "settings")}`}
    type="button"
    aria-label="Settings"
    aria-current={activeView === "settings" ? "page" : undefined}
    title="Settings"
    onclick={onShowSettings}
  >
    <Settings aria-hidden="true" size={18} />
  </button>
</header>
