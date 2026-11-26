<script lang="ts" module>
  export type HistoryToolbarProps = {
    onFetch: () => void;
    onPull: () => void;
    onPush: () => void;
    onBranch: () => void;
    onStash: () => void;
    onPop: () => void;
    onOpenInVSCode: () => void | Promise<void>;
    onOpenInExplorer: () => void | Promise<void>;
    canOpenRepositoryLocally?: boolean;
    repositoryKey?: string;
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
    ChevronDown,
  } from "@lucide/svelte";
  import { BRANCH_ICON_PATH } from "$lib/icons/branch";
  import { dismissContextMenu, showContextMenu } from "$lib/contextMenu";
  import { onDestroy } from "svelte";

  let {
    onFetch,
    onPull,
    onPush,
    onBranch,
    onStash,
    onPop,
    onOpenInVSCode,
    onOpenInExplorer,
    canPop = false,
    pending = false,
    pendingKind = null,
    disabled = false,
    canOpenRepositoryLocally = false,
    repositoryKey = "",
  }: HistoryToolbarProps = $props();

  const actionsDisabled = $derived(disabled || pending);
  let openError = $state("");
  let lastUsedTarget = $state<"vscode" | "explorer">("vscode");
  const menuOwner = {};
  let menuOpen = $state(false);
  let destroyed = false;

  onDestroy(() => { destroyed = true; dismissContextMenu(menuOwner); });

  $effect(() => {
    const key = repositoryKey;
    dismissContextMenu(menuOwner);
    menuOpen = false;
    openError = "";
    lastUsedTarget = readLastUsedTarget(key);
  });

  async function chooseOpenTarget(event: MouseEvent) {
    const key = repositoryKey;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    menuOpen = true;
    const target = await showContextMenu<"vscode" | "explorer">([
      { id: "vscode", label: "Visual Studio Code", icon: "vscode" },
      { id: "explorer", label: "Explorer", icon: "file-explorer" },
    ], { x: rect.right - 206, y: rect.bottom + 4 }, menuOwner, { width: 206 });
    menuOpen = false;
    if (!destroyed && key === repositoryKey && target) {
      await runOpen(target, target === "vscode" ? onOpenInVSCode : onOpenInExplorer);
    }
  }

  async function runOpen(target: "vscode" | "explorer", action: () => void | Promise<void>) {
    const repositoryKeyAtOpen = repositoryKey;
    openError = "";
    try {
      await action();
      if (repositoryKey === repositoryKeyAtOpen) lastUsedTarget = target;
      if (repositoryKeyAtOpen) {
        try {
          localStorage.setItem(openTargetStorageKey(repositoryKeyAtOpen), target);
        } catch {
          // Opening the app should still work when browser storage is unavailable.
        }
      }
    } catch (error) {
      if (destroyed || repositoryKey !== repositoryKeyAtOpen) return;
      openError = error instanceof Error && error.message
        ? error.message.slice(0, 180)
        : target === "vscode"
          ? "Could not open this repository in Visual Studio Code."
          : "Could not open this repository in Explorer.";
    }
  }

  function readLastUsedTarget(key: string): "vscode" | "explorer" {
    if (!key) return "vscode";
    try {
      return localStorage.getItem(openTargetStorageKey(key)) === "explorer" ? "explorer" : "vscode";
    } catch {
      return "vscode";
    }
  }

  function openTargetStorageKey(key: string) {
    return `gitgui:last-open-target:${encodeURIComponent(key)}`;
  }
</script>

<div
  aria-busy={pending}
  aria-label="Git actions"
  class="relative flex h-[var(--app-repository-header-height)] min-h-[var(--app-repository-header-height)] shrink-0 justify-center overflow-visible border-b border-[var(--app-theme-sidebar-border-subtle)] bg-[var(--app-theme-sidebar)]"
  role="toolbar"
>
  <div class="h-full min-w-0 flex-1 overflow-x-auto">
    <div class="flex h-full w-max min-w-full items-center justify-center gap-1 px-2">
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
  {#if canOpenRepositoryLocally}
    <div class="absolute right-2 top-1/2 z-30 -translate-y-1/2">
      <div class="open-in-control inline-flex h-8 items-stretch overflow-hidden rounded-sm text-[var(--app-theme-sidebar-foreground)] transition-colors">
        <button
          aria-label={lastUsedTarget === "vscode" ? "Open in Visual Studio Code" : "Open in Explorer"}
          class="flex items-center px-2 hover:bg-[var(--app-theme-sidebar-row-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--app-theme-focus)]"
          type="button"
          onclick={() => void runOpen(lastUsedTarget, lastUsedTarget === "vscode" ? onOpenInVSCode : onOpenInExplorer)}
        >
          {#if lastUsedTarget === "vscode"}
            <img alt="" aria-hidden="true" class="h-[17px] w-[17px] object-contain" src="/visual-studio-code.svg" />
          {:else}
            <img alt="" aria-hidden="true" class="h-[17px] w-[17px] object-contain" src="/file-explorer.png" />
          {/if}
        </button>
        <button
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          aria-label="Choose where to open repository"
          class="flex items-center px-1.5 hover:bg-[var(--app-theme-sidebar-row-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--app-theme-focus)]"
          type="button"
          onclick={chooseOpenTarget}
        >
          <ChevronDown aria-hidden="true" size={13} strokeWidth={1.75} />
        </button>
      </div>
      {#if openError}
        <p class="absolute right-0 top-full mt-1 w-max max-w-72 rounded-lg border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-overlay)] px-3 py-2 text-xs text-[var(--app-theme-text)] shadow-lg" role="status">{openError}</p>
      {/if}
    </div>
  {/if}

</div>

<style>
  .open-in-control:hover {
    background: color-mix(in srgb, var(--app-theme-sidebar-row-hover) 40%, transparent);
  }
</style>
