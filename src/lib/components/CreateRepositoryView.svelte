<script lang="ts">
  import { Cloud, FolderPlus, GitBranch, HardDriveDownload, Monitor, X } from "@lucide/svelte";

  export type CreateRepositoryProvider = "local" | "github" | "bitbucket";

  type Props = {
    provider: CreateRepositoryProvider;
    parentPath: string;
    name: string;
    initialBranch: string;
    initializeLfs: boolean;
    error?: string;
    loading?: boolean;
    canBrowse?: boolean;
    onProviderChange: (value: CreateRepositoryProvider) => void;
    onParentPathChange: (value: string) => void;
    onNameChange: (value: string) => void;
    onInitialBranchChange: (value: string) => void;
    onInitializeLfsChange: (value: boolean) => void;
    onBrowse: () => void | Promise<void>;
    onSubmit: () => void | Promise<void>;
    onCancel: () => void;
  };

  let {
    provider,
    parentPath,
    name,
    initialBranch,
    initializeLfs,
    error = "",
    loading = false,
    canBrowse = false,
    onProviderChange,
    onParentPathChange,
    onNameChange,
    onInitialBranchChange,
    onInitializeLfsChange,
    onBrowse,
    onSubmit,
    onCancel,
  }: Props = $props();

  let nameInput = $state<HTMLInputElement | null>(null);
  const fullPath = $derived(joinPath(parentPath.trim(), name.trim()));
  const isRemoteProvider = $derived(provider !== "local");
  const providerTitle = $derived(
    provider === "local" ? "Local" : provider === "github" ? "Github" : "Bitbucket",
  );

  $effect(() => {
    requestAnimationFrame(() => nameInput?.focus());
  });

  function joinPath(parent: string, child: string): string {
    if (!parent) return child;
    if (!child) return parent;
    if (/[\\/]$/.test(parent)) return `${parent}${child}`;
    return `${parent}${parent.includes("\\") && !parent.includes("/") ? "\\" : "/"}${child}`;
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!loading && !isRemoteProvider && parentPath.trim() && name.trim()) {
      void onSubmit();
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && !loading) {
      event.preventDefault();
      onCancel();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<section class="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--app-theme-canvas)] text-[var(--app-theme-text)]">
  <header class="flex h-11 shrink-0 items-center justify-between border-b border-[var(--app-theme-border)] px-4">
    <h1 class="text-base font-medium">Initialize a Repository</h1>
    <button
      class="inline-flex h-7 w-7 items-center justify-center rounded-[2px] text-[var(--app-theme-text-muted)] transition hover:bg-[var(--app-theme-sidebar-row-hover)] hover:text-[var(--app-theme-text)]"
      type="button"
      aria-label="Close"
      disabled={loading}
      onclick={onCancel}
    >
      <X aria-hidden="true" size={18} />
    </button>
  </header>

  <div class="grid min-h-0 flex-1 grid-cols-[230px_minmax(0,1fr)]">
    <nav class="min-h-0 border-r border-[var(--app-theme-border)] bg-[var(--app-theme-sidebar)] py-1" aria-label="Repository provider">
      <button
        class:provider-selected={provider === "local"}
        class="flex h-9 w-full items-center gap-3 px-3 text-left text-sm font-medium text-[var(--app-theme-text-secondary)] transition hover:bg-[var(--app-theme-sidebar-row-hover)] hover:text-[var(--app-theme-text)]"
        type="button"
        aria-current={provider === "local" ? "page" : undefined}
        onclick={() => onProviderChange("local")}
      >
        <Monitor aria-hidden="true" size={16} />
        Local
      </button>
      <button
        class:provider-selected={provider === "github"}
        class="flex h-9 w-full items-center gap-3 px-3 text-left text-sm font-medium text-[var(--app-theme-text-secondary)] transition hover:bg-[var(--app-theme-sidebar-row-hover)] hover:text-[var(--app-theme-text)]"
        type="button"
        aria-current={provider === "github" ? "page" : undefined}
        onclick={() => onProviderChange("github")}
      >
        <GitBranch aria-hidden="true" size={16} />
        Github
      </button>
      <button
        class:provider-selected={provider === "bitbucket"}
        class="flex h-9 w-full items-center gap-3 px-3 text-left text-sm font-medium text-[var(--app-theme-text-secondary)] transition hover:bg-[var(--app-theme-sidebar-row-hover)] hover:text-[var(--app-theme-text)]"
        type="button"
        aria-current={provider === "bitbucket" ? "page" : undefined}
        onclick={() => onProviderChange("bitbucket")}
      >
        <Cloud aria-hidden="true" size={16} />
        Bitbucket
      </button>
    </nav>

    <div class="min-h-0 overflow-auto">
      <form class="mx-auto max-w-[680px] px-5 py-4" onsubmit={submit}>
        <h2 class="mb-4 text-lg font-medium">{provider === "local" ? "Initialize a Repo" : `Create on ${providerTitle}`}</h2>

        <div class="grid grid-cols-[135px_minmax(0,1fr)] items-center gap-x-4 gap-y-2">
          <label class="text-right text-sm text-[var(--app-theme-text-secondary)]" for="create-repository-name">Name</label>
          <input
            bind:this={nameInput}
            id="create-repository-name"
              class="h-8 min-w-0 rounded-[2px] border border-[var(--app-theme-input)] bg-[var(--app-theme-canvas)] px-2.5 text-sm text-[var(--app-theme-text)] outline-none transition placeholder:text-[var(--app-theme-placeholder)] focus:border-[var(--app-theme-focus)] focus:ring-2 focus:ring-[var(--app-theme-focus-ring)]"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="my-new-project"
            value={name}
            disabled={loading}
            oninput={(event) => onNameChange(event.currentTarget.value)}
          />

          <label class="text-right text-sm text-[var(--app-theme-text-secondary)]" for="create-repository-location">Location</label>
          <div class="flex min-w-0 gap-2">
            <input
              id="create-repository-location"
              class="h-8 min-w-0 flex-1 rounded-[2px] border border-[var(--app-theme-input)] bg-[var(--app-theme-canvas)] px-2.5 font-mono text-sm text-[var(--app-theme-text)] outline-none transition placeholder:text-[var(--app-theme-placeholder)] focus:border-[var(--app-theme-focus)] focus:ring-2 focus:ring-[var(--app-theme-focus-ring)]"
              type="text"
              autocomplete="off"
              spellcheck="false"
              placeholder="C:\\Projects or /home/me/projects"
              value={parentPath}
              disabled={loading}
              oninput={(event) => onParentPathChange(event.currentTarget.value)}
            />
            <button
              class="inline-flex h-8 shrink-0 items-center gap-2 rounded-[2px] border border-[var(--app-theme-accent)] bg-[var(--app-theme-accent-surface)] px-3 text-sm font-medium text-[var(--app-theme-accent-surface-foreground)] transition-colors hover:bg-[var(--app-theme-sidebar-row-hover)] disabled:cursor-not-allowed disabled:opacity-45"
              type="button"
              disabled={loading || !canBrowse || isRemoteProvider}
              title={isRemoteProvider ? "Remote repository creation is not connected" : canBrowse ? "Browse for a folder" : "Folder browsing is available in the desktop app"}
              onclick={() => void onBrowse()}
            >
              Browse
            </button>
          </div>

          <span class="text-right text-sm text-[var(--app-theme-text-secondary)]">Full path</span>
          <output class="min-w-0 break-all py-1 font-mono text-sm text-[var(--app-theme-text)]" aria-live="polite">
            {fullPath || "Choose a location and enter a repository name"}
          </output>

          <label class="text-right text-sm text-[var(--app-theme-text-secondary)]" for="create-repository-branch">Default branch name</label>
          <input
            id="create-repository-branch"
            class="h-8 min-w-0 rounded-[2px] border border-[var(--app-theme-input)] bg-[var(--app-theme-canvas)] px-2.5 font-mono text-sm text-[var(--app-theme-text)] outline-none transition placeholder:text-[var(--app-theme-placeholder)] focus:border-[var(--app-theme-focus)] focus:ring-2 focus:ring-[var(--app-theme-focus-ring)]"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="main"
            value={initialBranch}
            disabled={loading}
            oninput={(event) => onInitialBranchChange(event.currentTarget.value)}
          />

          <span class="text-right text-sm text-[var(--app-theme-text-secondary)]">Initialize with LFS</span>
          <label class="flex h-8 items-center gap-2 text-sm text-[var(--app-theme-text-secondary)]" for="create-repository-lfs">
            <input
              id="create-repository-lfs"
              class="h-4 w-4 accent-[var(--app-theme-accent)]"
              type="checkbox"
              checked={initializeLfs}
              disabled={loading}
              onchange={(event) => onInitializeLfsChange(event.currentTarget.checked)}
            />
            <HardDriveDownload aria-hidden="true" size={16} />
          </label>

          {#if isRemoteProvider}
            <span></span>
            <p class="text-sm text-[var(--app-theme-text-muted)]">{providerTitle} account connection is not available yet.</p>
          {/if}

          {#if error}
            <span></span>
            <p class="text-sm text-[var(--app-theme-error)]" role="alert">{error}</p>
          {/if}
        </div>

        <footer class="mt-5 flex justify-end gap-2">
          <button
            class="h-8 rounded-[2px] px-3 text-sm font-medium text-[var(--app-theme-text-muted)] transition hover:bg-[var(--app-theme-sidebar-row-hover)] disabled:cursor-not-allowed disabled:opacity-45"
            type="button"
            disabled={loading}
            onclick={onCancel}
          >
            Cancel
          </button>
          <button
            class="inline-flex h-8 items-center justify-center gap-2 rounded-[2px] border border-[var(--app-theme-accent)] bg-[var(--app-theme-accent-surface)] px-4 text-sm font-medium text-[var(--app-theme-accent-surface-foreground)] transition-colors hover:bg-[var(--app-theme-sidebar-row-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)] disabled:cursor-not-allowed disabled:opacity-45"
            type="submit"
            disabled={loading || isRemoteProvider || !parentPath.trim() || !name.trim()}
          >
            <FolderPlus aria-hidden="true" size={16} />
            {loading ? "Creating…" : "Create Repository"}
          </button>
        </footer>
      </form>
    </div>
  </div>
</section>

<style>
  .provider-selected {
    background: var(--app-theme-accent-surface);
    color: var(--app-theme-accent-surface-foreground);
  }
</style>
