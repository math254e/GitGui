<script lang="ts" module>
  export type HistoryToolbarProps = {
    onFetch: () => void;
    onPull: () => void;
    onPush: () => void;
    onBranch: () => void;
    onStash: () => void;
    onPop: () => void;
    pending?: boolean;
    disabled?: boolean;
  };
</script>

<script lang="ts">
  import {
    Archive,
    ArchiveRestore,
    ArrowDownToLine,
    Download,
    GitBranch,
    Upload,
  } from "@lucide/svelte";

  let {
    onFetch,
    onPull,
    onPush,
    onBranch,
    onStash,
    onPop,
    pending = false,
    disabled = false,
  }: HistoryToolbarProps = $props();

  const actionsDisabled = $derived(disabled || pending);
</script>

<div
  aria-busy={pending}
  aria-label="Git actions"
  class="flex min-h-12 items-center gap-1 overflow-x-auto border-b border-[var(--app-theme-toolbar-border)] bg-[var(--app-theme-toolbar)] px-2"
  role="toolbar"
>
  <button
    aria-label="Fetch from remote"
    class="group inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-semibold text-[var(--app-theme-toolbar-foreground)] transition-colors hover:bg-[var(--app-theme-toolbar-control-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)] disabled:cursor-not-allowed disabled:opacity-45"
    disabled={actionsDisabled}
    title="Fetch from remote"
    type="button"
    onclick={onFetch}
  >
    <Download aria-hidden="true" size={16} strokeWidth={2} />
    <span>Fetch</span>
  </button>

  <button
    aria-label="Pull from remote"
    class="group inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-semibold text-[var(--app-theme-toolbar-foreground)] transition-colors hover:bg-[var(--app-theme-toolbar-control-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)] disabled:cursor-not-allowed disabled:opacity-45"
    disabled={actionsDisabled}
    title="Pull from remote"
    type="button"
    onclick={onPull}
  >
    <ArrowDownToLine aria-hidden="true" size={16} strokeWidth={2} />
    <span>Pull</span>
  </button>

  <span class="mx-1 h-5 w-px shrink-0 bg-[var(--app-theme-toolbar-border)]" aria-hidden="true"></span>

  <button
    aria-label="Push to remote"
    class="group inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-semibold text-[var(--app-theme-toolbar-foreground)] transition-colors hover:bg-[var(--app-theme-toolbar-control-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)] disabled:cursor-not-allowed disabled:opacity-45"
    disabled={actionsDisabled}
    title="Push to remote"
    type="button"
    onclick={onPush}
  >
    <Upload aria-hidden="true" size={16} strokeWidth={2} />
    <span>Push</span>
  </button>

  <button
    aria-label="Manage branches"
    class="group inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-semibold text-[var(--app-theme-toolbar-foreground)] transition-colors hover:bg-[var(--app-theme-toolbar-control-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)] disabled:cursor-not-allowed disabled:opacity-45"
    disabled={actionsDisabled}
    title="Manage branches"
    type="button"
    onclick={onBranch}
  >
    <GitBranch aria-hidden="true" size={16} strokeWidth={2} />
    <span>Branch</span>
  </button>

  <button
    aria-label="Stash changes"
    class="group inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-semibold text-[var(--app-theme-toolbar-foreground)] transition-colors hover:bg-[var(--app-theme-toolbar-control-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)] disabled:cursor-not-allowed disabled:opacity-45"
    disabled={actionsDisabled}
    title="Stash changes"
    type="button"
    onclick={onStash}
  >
    <Archive aria-hidden="true" size={16} strokeWidth={2} />
    <span>Stash</span>
  </button>

  <button
    aria-label="Pop latest stash"
    class="group inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-semibold text-[var(--app-theme-toolbar-foreground)] transition-colors hover:bg-[var(--app-theme-toolbar-control-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)] disabled:cursor-not-allowed disabled:opacity-45"
    disabled={actionsDisabled}
    title="Pop latest stash"
    type="button"
    onclick={onPop}
  >
    <ArchiveRestore aria-hidden="true" size={16} strokeWidth={2} />
    <span>Pop</span>
  </button>

</div>
