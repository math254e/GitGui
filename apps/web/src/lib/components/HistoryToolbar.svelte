<script lang="ts" module>
  export type HistoryToolbarProps = {
    onFetch: () => void;
    onPull: () => void;
    onPush: () => void;
    onBranch: () => void;
    onStash: () => void;
    onPop: () => void;
    canPop?: boolean;
    pending?: boolean;
    pendingKind?: string | null;
    disabled?: boolean;
  };
</script>

<script lang="ts">
  import {
    Archive,
    ArchiveRestore,
    ArrowDownToLine,
    Download,
    LoaderCircle,
    Upload,
  } from "@lucide/svelte";
  import { BRANCH_ICON_PATH } from "$lib/icons/branch";

  let {
    onFetch,
    onPull,
    onPush,
    onBranch,
    onStash,
    onPop,
    canPop = false,
    pending = false,
    pendingKind = null,
    disabled = false,
  }: HistoryToolbarProps = $props();

  const actionsDisabled = $derived(disabled || pending);
</script>

<div
  aria-busy={pending}
  aria-label="Git actions"
  class="flex h-[var(--app-repository-header-height)] min-h-[var(--app-repository-header-height)] shrink-0 justify-center overflow-x-auto border-b border-[var(--app-theme-sidebar-border-subtle)] bg-[var(--app-theme-sidebar)]"
  role="toolbar"
>
  <div class="flex w-max min-w-full items-center justify-center gap-1 px-2">
    <button
      aria-label="Fetch from remote"
      aria-busy={pendingKind === "fetch"}
      class="group inline-flex h-8 min-w-0 shrink-0 flex-row-reverse items-center justify-center gap-1.5 rounded-sm px-2.5 py-1 text-xs font-medium leading-4 text-[var(--app-theme-sidebar-foreground)] transition-colors hover:bg-[var(--app-theme-sidebar-row-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)] disabled:cursor-not-allowed disabled:opacity-45"
      disabled={actionsDisabled}
      title="Fetch branches and tags from remote"
      type="button"
      onclick={onFetch}
    >
      <span>Fetch</span>
      {#if pendingKind === "fetch"}
        <LoaderCircle aria-hidden="true" class="animate-spin" size={16} strokeWidth={1.75} />
      {:else}
        <Download aria-hidden="true" size={16} strokeWidth={1.75} />
      {/if}
    </button>

    <button
      aria-label="Pull from remote"
      aria-busy={pendingKind === "pull"}
      class="group inline-flex h-8 min-w-0 shrink-0 flex-row-reverse items-center justify-center gap-1.5 rounded-sm px-2.5 py-1 text-xs font-medium leading-4 text-[var(--app-theme-sidebar-foreground)] transition-colors hover:bg-[var(--app-theme-sidebar-row-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)] disabled:cursor-not-allowed disabled:opacity-45"
      disabled={actionsDisabled}
      title="Pull from remote"
      type="button"
      onclick={onPull}
    >
      <span>Pull</span>
      {#if pendingKind === "pull"}
        <LoaderCircle aria-hidden="true" class="animate-spin" size={16} strokeWidth={1.75} />
      {:else}
        <ArrowDownToLine aria-hidden="true" size={16} strokeWidth={1.75} />
      {/if}
    </button>

    <button
      aria-label="Push to remote"
      aria-busy={pendingKind === "push"}
      class="group inline-flex h-8 min-w-0 shrink-0 flex-row-reverse items-center justify-center gap-1.5 rounded-sm px-2.5 py-1 text-xs font-medium leading-4 text-[var(--app-theme-sidebar-foreground)] transition-colors hover:bg-[var(--app-theme-sidebar-row-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)] disabled:cursor-not-allowed disabled:opacity-45"
      disabled={actionsDisabled}
      title="Push branch updates and tags to remote"
      type="button"
      onclick={onPush}
    >
      <span>Push</span>
      {#if pendingKind === "push"}
        <LoaderCircle aria-hidden="true" class="animate-spin" size={16} strokeWidth={1.75} />
      {:else}
        <Upload aria-hidden="true" size={16} strokeWidth={1.75} />
      {/if}
    </button>

    <button
      aria-label="Manage branches"
      aria-busy={pendingKind === "switchBranch" || pendingKind === "createBranch"}
      class="group inline-flex h-8 min-w-0 shrink-0 flex-row-reverse items-center justify-center gap-1.5 rounded-sm px-2.5 py-1 text-xs font-medium leading-4 text-[var(--app-theme-sidebar-foreground)] transition-colors hover:bg-[var(--app-theme-sidebar-row-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)] disabled:cursor-not-allowed disabled:opacity-45"
      disabled={actionsDisabled}
      title="Manage branches"
      type="button"
      onclick={onBranch}
    >
      <span>Branch</span>
      {#if pendingKind === "switchBranch" || pendingKind === "createBranch"}
        <LoaderCircle aria-hidden="true" class="animate-spin" size={16} strokeWidth={1.75} />
      {:else}
        <svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16">
          <path d={BRANCH_ICON_PATH} fill="currentColor" fill-rule="evenodd" />
        </svg>
      {/if}
    </button>

    <button
      aria-label="Stash changes"
      aria-busy={pendingKind === "stash"}
      class="group inline-flex h-8 min-w-0 shrink-0 flex-row-reverse items-center justify-center gap-1.5 rounded-sm px-2.5 py-1 text-xs font-medium leading-4 text-[var(--app-theme-sidebar-foreground)] transition-colors hover:bg-[var(--app-theme-sidebar-row-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)] disabled:cursor-not-allowed disabled:opacity-45"
      disabled={actionsDisabled}
      title="Stash changes"
      type="button"
      onclick={onStash}
    >
      <span>Stash</span>
      {#if pendingKind === "stash"}
        <LoaderCircle aria-hidden="true" class="animate-spin" size={16} strokeWidth={1.75} />
      {:else}
        <Archive aria-hidden="true" size={16} strokeWidth={1.75} />
      {/if}
    </button>

    <button
      aria-label="Pop latest stash"
      aria-busy={pendingKind === "stashPop"}
      class="group inline-flex h-8 min-w-0 shrink-0 flex-row-reverse items-center justify-center gap-1.5 rounded-sm px-2.5 py-1 text-xs font-medium leading-4 text-[var(--app-theme-sidebar-foreground)] transition-colors hover:bg-[var(--app-theme-sidebar-row-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)] disabled:cursor-not-allowed disabled:opacity-45"
      disabled={actionsDisabled || !canPop}
      title="Pop latest stash"
      type="button"
      onclick={onPop}
    >
      <span>Pop</span>
      {#if pendingKind === "stashPop"}
        <LoaderCircle aria-hidden="true" class="animate-spin" size={16} strokeWidth={1.75} />
      {:else}
        <ArchiveRestore aria-hidden="true" size={16} strokeWidth={1.75} />
      {/if}
    </button>
  </div>

</div>
