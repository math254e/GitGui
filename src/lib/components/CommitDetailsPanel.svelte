<script lang="ts">
  import CommitFilesTree from "$lib/components/CommitFilesTree.svelte";
  import type { GitGuiClient } from "$lib/client-runtime/client";
  import { onDestroy } from "svelte";
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
  let activeFilesRequest = 0;
  let destroyed = false;

  $effect(() => {
    void loadFiles(repositoryId, selectedCommit.hash);
  });

  onDestroy(() => {
    destroyed = true;
    activeFilesRequest += 1;
  });

  function formatDate(timestamp: number) {
    return new Date(timestamp * 1000).toLocaleString();
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
  <div class="flex h-full flex-col overflow-auto px-5 py-5">
    <div class="mb-5">
      <h2 class="text-xs font-bold uppercase text-[var(--app-theme-sidebar-muted-foreground)]">Commit details</h2>
    </div>

    <section class="flex min-h-0 flex-1 flex-col space-y-5">
      <div>
        <p class="mb-1 text-xs font-bold uppercase text-[var(--app-theme-text-subtle)]">Commit</p>
        <h3 class="text-lg font-semibold leading-snug text-[var(--app-theme-text)]">{selectedCommit.message}</h3>
      </div>

      <dl class="space-y-4 text-sm">
        <div>
          <dt class="text-xs font-bold uppercase text-[var(--app-theme-text-subtle)]">Hash</dt>
          <dd class="mt-1 break-all font-mono text-[var(--app-theme-sidebar-foreground)]">{selectedCommit.hash}</dd>
        </div>
        <div>
          <dt class="text-xs font-bold uppercase text-[var(--app-theme-text-subtle)]">Author</dt>
          <dd class="mt-1 text-[var(--app-theme-sidebar-foreground)]">{selectedCommit.author}</dd>
        </div>
        <div>
          <dt class="text-xs font-bold uppercase text-[var(--app-theme-text-subtle)]">Date</dt>
          <dd class="mt-1 text-[var(--app-theme-sidebar-foreground)]">{formatDate(selectedCommit.timestamp)}</dd>
        </div>
        <div>
          <dt class="text-xs font-bold uppercase text-[var(--app-theme-text-subtle)]">Parents</dt>
          <dd class="mt-1 text-[var(--app-theme-sidebar-foreground)]">{selectedCommit.parents.length || "None"}</dd>
        </div>
      </dl>

      <div class="flex min-h-0 flex-1 flex-col">
        <div class="mb-3 flex items-center justify-between gap-3">
          <p class="text-xs font-bold uppercase text-[var(--app-theme-text-subtle)]">Files</p>
          {#if !filesLoading && !filesError}
            <span class="text-xs text-[var(--app-theme-text-subtle)]">{commitFiles.length} files</span>
          {/if}
        </div>

        {#if filesLoading}
          <div class="rounded-md border border-[var(--app-theme-border)] px-3 py-3 text-sm text-[var(--app-theme-text-subtle)]">
            Loading files...
          </div>
        {:else if filesError}
          <div class="rounded-md border border-[var(--app-theme-error-border)] bg-[var(--app-theme-error-surface)] px-3 py-3 text-sm text-[var(--app-theme-error)]">
            {filesError}
          </div>
        {:else if commitFiles.length}
          <CommitFilesTree files={commitFiles} {selectedFile} {onSelectFile} />
        {:else}
          <div class="rounded-md border border-[var(--app-theme-border)] px-3 py-3 text-sm text-[var(--app-theme-text-subtle)]">
            This commit does not list file changes.
          </div>
        {/if}
      </div>
    </section>
  </div>
</aside>
