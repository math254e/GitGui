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
    activeView: "start" | "repo";
    activeRepoId: string | null;
    tabs: RepoTab[];
    onShowStart: () => void;
    onSelectRepo: (repoId: string) => void;
    onCloseRepo: (repoId: string) => void;
  };

  let { activeView, activeRepoId, tabs, onShowStart, onSelectRepo, onCloseRepo }: Props = $props();
</script>

<header class="flex h-12 min-h-12 items-center border-b border-[#d8dde4] bg-white">
  <button
    class={`flex h-full w-12 shrink-0 items-center justify-center border-r border-[#d8dde4] transition ${
      activeView === "start" ? "bg-[#e9f8f5] text-[#183d38]" : "text-[#4f5b67] hover:bg-[#f8fafb]"
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
          class={`group flex h-full min-w-36 max-w-64 items-center border-r border-[#d8dde4] transition ${
            activeView === "repo" && activeRepoId === tab.id
              ? "bg-[#f8fafb] text-[#202124]"
              : "bg-white text-[#4f5b67] hover:bg-[#f8fafb]"
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
              <span class={`block truncate text-xs ${tab.error ? "text-[#9f3f33]" : "text-[#89929d]"}`}>
                {tab.error || tab.branch}
              </span>
            </span>
            {#if tab.loading}
              <span class="h-2 w-2 shrink-0 rounded-full bg-[#4d9d91]" aria-label="Loading"></span>
            {/if}
          </button>
          <button
            class="mr-2 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-[#6d7784] transition hover:bg-[#e7ebef] hover:text-[#202124]"
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
      <div class="flex h-full items-center px-4 text-sm text-[#89929d]">No repositories open</div>
    {/if}
  </nav>

  <button
    class="flex h-full w-12 shrink-0 items-center justify-center border-l border-[#d8dde4] text-[#4f5b67] transition hover:bg-[#f8fafb]"
    type="button"
    aria-label="Settings"
    title="Settings"
  >
    <Settings aria-hidden="true" size={18} />
  </button>
</header>
