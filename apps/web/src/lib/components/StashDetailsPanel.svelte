<script lang="ts">
  import { onDestroy } from "svelte";
  import type { GitGuiClient } from "@gitgui/client-runtime";
  import type { StashInfo, CommitFile } from "@gitgui/contracts";
  import CommitFilesTree from "./CommitFilesTree.svelte";
  import { StashRead } from "$lib/workspace/stash-read";
  import { stashFilesCache } from "$lib/workspace/stash-files-cache";
  import { formatError } from "$lib/workspace/errors";
  let { client, repositoryId, stash, selectedFile, onSelectFile }: {
    client: GitGuiClient; repositoryId: string; stash: StashInfo; selectedFile: CommitFile | null;
    onSelectFile: (file: CommitFile) => void;
  } = $props();
  let files = $state.raw<CommitFile[]>([]);
  let loading = $state(false);
  let error = $state("");
  let retry = $state(0);
  // Snapshot refreshes replace metadata objects; saved files change only when
  // their target changes. Keep the current request and tree for the same entry.
  const stashSelector = $derived(stash.selector);
  const stashOid = $derived(stash.hash);
  const read = new StashRead();
  let displayed: { client: GitGuiClient; repositoryId: string; oid: string; files: CommitFile[] } | undefined;
  $effect(() => {
    const currentClient = client;
    const id = repositoryId;
    const target = { selector: stashSelector, expectedOid: stashOid };
    void retry;
    const request = read.begin();
    const cache = stashFilesCache(currentClient);
    const cached = cache.get(id, target.expectedOid)
      ?? (displayed?.client === currentClient && displayed.repositoryId === id && displayed.oid === target.expectedOid ? displayed.files : undefined);
    files = cached ?? []; error = "";
    if (!currentClient.serverWelcome.capabilities.includes("git.stash.files")) {
      cache.delete(id, target.expectedOid);
      files = []; displayed = undefined;
      loading = false; error = "This server does not support stash inspection."; return () => read.cancel();
    }
    loading = cached === undefined;
    void currentClient.getStashFiles({ repositoryId: id, target }, request.signal).then((result) => {
      if (request.current()) {
        if (result.stash.hash !== target.expectedOid || result.stash.selector !== target.selector) throw new Error("The stash changed. Select it again to inspect it.");
        files = cache.put(id, target.expectedOid, result.files);
        displayed = { client: currentClient, repositoryId: id, oid: target.expectedOid, files };
      }
    }).catch((caught) => {
      if (request.current()) {
        cache.delete(id, target.expectedOid);
        displayed = undefined; files = []; error = formatError(caught);
      }
    })
      .finally(() => { if (request.current()) loading = false; });
    return () => read.cancel();
  });
  onDestroy(() => read.cancel());
</script>

<aside class="flex h-full min-h-0 flex-col overflow-hidden border-l border-[var(--app-theme-sidebar-border)] bg-[var(--app-theme-sidebar)]">
  <header title={stash.selector} class="shrink-0 border-b border-[var(--app-theme-border)] px-5 py-4">
    <p class="text-xs font-bold uppercase tracking-wide text-[var(--app-theme-text-subtle)]">Stash details</p>
  </header>
  <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-5 py-4">
    <p title={stash.selector} class="max-h-40 shrink-0 overflow-auto whitespace-pre-wrap break-words border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-raised)] p-3 text-sm">{stash.message}</p>
    <dl class="shrink-0 space-y-2 border-y border-[var(--app-theme-border)] py-3 text-sm">
      <div><dt class="text-xs text-[var(--app-theme-text-subtle)]">Original branch</dt><dd class="break-all">{stash.branch ?? "Unknown"}</dd></div>
      <div><dt class="text-xs text-[var(--app-theme-text-subtle)]">Date</dt><dd>{new Date(stash.timestamp * 1000).toLocaleString()}</dd></div>
      <div><dt class="text-xs text-[var(--app-theme-text-subtle)]">Original base</dt><dd class="break-all font-mono text-xs">{stash.baseHash}</dd></div>
      <div><dt class="text-xs text-[var(--app-theme-text-subtle)]">Stash object</dt><dd class="break-all font-mono text-xs">{stash.hash}</dd></div>
    </dl>
    <section class="flex min-h-[160px] flex-1 flex-col" aria-label="Saved files">
      {#if loading}<p role="status" class="text-sm">Loading saved files…</p>
      {:else if error}<p role="alert" class="text-sm">{error}</p><button type="button" class="mt-2 self-start border border-[var(--app-theme-border)] px-2 py-1 text-sm" onclick={() => retry += 1}>Retry</button>
      {:else if !files.length}<p class="text-sm text-[var(--app-theme-text-subtle)]">No saved file changes.</p>
      {:else}<p class="mb-2 text-xs text-[var(--app-theme-text-subtle)]">{files.length} saved {files.length === 1 ? "file" : "files"} · Read only</p><CommitFilesTree {files} {selectedFile} {onSelectFile} />{/if}
    </section>
  </div>
</aside>
