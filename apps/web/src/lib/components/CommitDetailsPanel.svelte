<script lang="ts">
  import { CalendarDays, FilePenLine, GitBranch, GitCommitHorizontal, Minus, Pencil, Plus, UserRound } from "@lucide/svelte";
  import { onDestroy } from "svelte";
  import CommitFilesTree from "$lib/components/CommitFilesTree.svelte";
  import type { GitGuiClient } from "@gitgui/client-runtime";
  import type { CommitFile, CommitInfo, RepositorySnapshot } from "$lib/types/repository";

  type Props = {
    client: GitGuiClient;
    repositoryId: string;
    snapshot: RepositorySnapshot;
    selectedCommit: CommitInfo;
    selectedFile: CommitFile | null;
    onSelectFile: (file: CommitFile) => void;
  };

  let { client, repositoryId, snapshot, selectedCommit, selectedFile, onSelectFile }: Props = $props();
  let commitFiles = $state<CommitFile[]>([]);
  let filesLoading = $state(false);
  let filesError = $state("");
  let messageCardHeight = $state(112);
  let resizingMessage = $state(false);
  let resizeStartY = 0;
  let resizeStartHeight = 0;
  let activeFilesRequest = 0;
  let lastFilesRequestKey = "";
  let destroyed = false;

  let fileStatusCounts = $derived(getFileStatusCounts(commitFiles));

  $effect(() => {
    const requestKey = `${repositoryId}\0${selectedCommit.hash}`;
    if (requestKey === lastFilesRequestKey) {
      return;
    }

    lastFilesRequestKey = requestKey;
    void loadFiles(repositoryId, selectedCommit.hash);
  });

  onDestroy(() => {
    destroyed = true;
    activeFilesRequest += 1;
    stopMessageResize();
  });

  function formatDate(timestamp: number) {
    return new Date(timestamp * 1000).toLocaleString();
  }

  function shortHash(hash: string) {
    return hash.slice(0, 7);
  }

  function formatParentHashes(parents: string[]) {
    return parents.map(shortHash).join(", ");
  }

  function startMessageResize(event: PointerEvent) {
    event.preventDefault();
    resizingMessage = true;
    resizeStartY = event.clientY;
    resizeStartHeight = messageCardHeight;
    window.addEventListener("pointermove", handleMessageResize);
    window.addEventListener("pointerup", stopMessageResize);
  }

  function handleMessageResize(event: PointerEvent) {
    if (!resizingMessage) {
      return;
    }

    messageCardHeight = clamp(resizeStartHeight + event.clientY - resizeStartY, 82, 280);
  }

  function stopMessageResize() {
    resizingMessage = false;

    if (typeof window !== "undefined") {
      window.removeEventListener("pointermove", handleMessageResize);
      window.removeEventListener("pointerup", stopMessageResize);
    }
  }

  function handleMessageResizeKeydown(event: KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      messageCardHeight = clamp(messageCardHeight + 8, 82, 280);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      messageCardHeight = clamp(messageCardHeight - 8, 82, 280);
    }
  }

  function clamp(value: number, minimum: number, maximum: number) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function getFileStatusCounts(files: CommitFile[]) {
    const counts = {
      modified: 0,
      added: 0,
      deleted: 0,
      renamed: 0,
    };

    for (const file of files) {
      switch (file.status.charAt(0).toUpperCase()) {
        case "A":
          counts.added += 1;
          break;
        case "D":
          counts.deleted += 1;
          break;
        case "R":
          counts.renamed += 1;
          break;
        default:
          counts.modified += 1;
          break;
      }
    }

    return counts;
  }

  async function loadFiles(repositoryId: string, commitHash: string) {
    if (destroyed) {
      return;
    }

    const request = ++activeFilesRequest;
    commitFiles = [];
    filesError = "";
    filesLoading = true;

    try {
      const result = await client.getCommitFiles(repositoryId, commitHash);

      if (!destroyed && request === activeFilesRequest) {
        commitFiles = result.files;
      }
    } catch (caught) {
      if (!destroyed && request === activeFilesRequest) {
        filesError = formatError(caught);
      }
    } finally {
      if (!destroyed && request === activeFilesRequest) {
        filesLoading = false;
      }
    }
  }

  function formatError(caught: unknown) {
    if (typeof caught === "object" && caught && "message" in caught) {
      const details =
        "stderr" in caught && typeof caught.stderr === "string" && caught.stderr
          ? ` ${caught.stderr}`
          : "";
      return `${caught.message}${details}`;
    }

    return String(caught);
  }
</script>

<aside class="min-h-0 border-l border-[var(--app-theme-sidebar-border)] bg-[var(--app-theme-sidebar)]">
  <div class="flex h-full min-h-0 flex-col overflow-hidden">
    <header class="shrink-0 border-b border-[var(--app-theme-sidebar-border)] px-5 py-2.5">
      <div class="flex items-center justify-between gap-2">
        <div class="flex min-w-0 items-center gap-2">
          <span class="grid h-6 w-6 shrink-0 place-items-center bg-[var(--app-theme-accent)]/12 text-[var(--app-theme-accent)]">
            <GitCommitHorizontal aria-hidden="true" size={14} strokeWidth={2.25} />
          </span>
          <p class="truncate text-xs font-semibold text-[var(--app-theme-sidebar-foreground)]">
            Commit:
            <code class="font-mono" title={selectedCommit.hash}>{shortHash(selectedCommit.hash)}</code>
          </p>
        </div>
      </div>
    </header>

    <div class="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-5 py-5">
      <div class="-mx-2 shrink-0">
        <section
          class="flex min-h-0 flex-col overflow-hidden rounded-[2px] border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-raised)]"
          style={`height: ${messageCardHeight}px`}
        >
          <div class="min-h-0 flex-1 overflow-auto p-4 pb-0">
            <h2 class="text-[15px] font-normal leading-6 text-[var(--app-theme-text)]">{selectedCommit.message}</h2>
          </div>
        </section>
      </div>

      <div class="relative shrink-0">
        <div
          class={`group absolute -top-5 inset-x-0 h-5 cursor-row-resize touch-none text-[var(--app-theme-border)] ${resizingMessage ? "text-[var(--app-theme-accent)]" : ""}`}
          role="slider"
          aria-label="Resize commit message"
          aria-orientation="horizontal"
          aria-valuemin="82"
          aria-valuemax="280"
          aria-valuenow={messageCardHeight}
          tabindex="0"
          onpointerdown={startMessageResize}
          onkeydown={handleMessageResizeKeydown}
        >
          <span class="absolute inset-x-0 bottom-0 h-px bg-current transition-colors group-hover:bg-[var(--app-theme-accent)]"></span>
        </div>
        <dl class="grid grid-cols-2 gap-x-4 gap-y-4 border-y border-[var(--app-theme-border)] py-4">
        <div class="min-w-0">
          <dt class="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--app-theme-text-subtle)]">
            <UserRound aria-hidden="true" size={13} />
            Author
          </dt>
          <dd class="mt-1 truncate text-sm text-[var(--app-theme-sidebar-foreground)]" title={selectedCommit.author}>{selectedCommit.author}</dd>
        </div>
        <div class="min-w-0">
          <dt class="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--app-theme-text-subtle)]">
            <GitBranch aria-hidden="true" size={13} />
            Parents
          </dt>
          <dd class="mt-1 flex flex-col gap-1 font-mono text-xs text-[var(--app-theme-sidebar-foreground)]">
            {#if selectedCommit.parents.length}
              <code title={selectedCommit.parents.join(", ")}>{formatParentHashes(selectedCommit.parents)}</code>
            {:else}
              <span class="font-sans text-sm">None</span>
            {/if}
          </dd>
        </div>
        <div class="col-span-2 min-w-0">
          <dt class="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--app-theme-text-subtle)]">
            <CalendarDays aria-hidden="true" size={13} />
            Date
          </dt>
          <dd class="mt-1 text-sm text-[var(--app-theme-sidebar-foreground)]">{formatDate(selectedCommit.timestamp)}</dd>
        </div>
        </dl>
      </div>

      <section class="flex min-h-[220px] flex-1 flex-col">
        {#if !filesLoading && !filesError && commitFiles.length}
          <div class="mb-3 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--app-theme-sidebar-foreground)]" aria-label="Changed files summary">
            {#if fileStatusCounts.modified}
              <span class="inline-flex items-center gap-1.5 whitespace-nowrap" title={`${fileStatusCounts.modified} modified files`}>
                <Pencil aria-hidden="true" size={13} strokeWidth={2.25} class="text-[#d09a2e]" />
                {fileStatusCounts.modified} modified
              </span>
            {/if}
            {#if fileStatusCounts.added}
              <span class="inline-flex items-center gap-1.5 whitespace-nowrap" title={`${fileStatusCounts.added} added files`}>
                <Plus aria-hidden="true" size={15} strokeWidth={2.25} class="text-[#2f9e6f]" />
                {fileStatusCounts.added} added
              </span>
            {/if}
            {#if fileStatusCounts.deleted}
              <span class="inline-flex items-center gap-1.5 whitespace-nowrap" title={`${fileStatusCounts.deleted} deleted files`}>
                <Minus aria-hidden="true" size={15} strokeWidth={2.25} class="text-[#e5484d]" />
                {fileStatusCounts.deleted} deleted
              </span>
            {/if}
            {#if fileStatusCounts.renamed}
              <span class="inline-flex items-center gap-1.5 whitespace-nowrap" title={`${fileStatusCounts.renamed} renamed files`}>
                <FilePenLine aria-hidden="true" size={14} strokeWidth={2.25} class="text-[#8b5cf6]" />
                {fileStatusCounts.renamed} renamed
              </span>
            {/if}
          </div>
        {/if}

        {#if filesLoading}
          <div class="grid min-h-0 flex-1 place-items-center px-3 py-5 text-sm text-[var(--app-theme-text-subtle)]">
            Loading files...
          </div>
        {:else if filesError}
          <div class="border border-[var(--app-theme-error-border)] bg-[var(--app-theme-error-surface)] px-3 py-3 text-sm text-[var(--app-theme-error)]">
            {filesError}
          </div>
        {:else if commitFiles.length}
          <div class="-mx-2 min-h-0 flex-1 overflow-hidden">
            <CommitFilesTree files={commitFiles} {selectedFile} {onSelectFile} />
          </div>
        {:else}
          <div class="rounded-[2px] border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-raised)] px-3 py-3 text-sm text-[var(--app-theme-text-subtle)]">
            This commit does not list file changes.
          </div>
        {/if}
      </section>
    </div>
  </div>
</aside>
