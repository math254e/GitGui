<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import CommitFileDiffViewer from "$lib/components/CommitFileDiffViewer.svelte";
  import DetailsPanel from "$lib/components/DetailsPanel.svelte";
  import GitGraph from "$lib/components/GitGraph.svelte";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import TopMenu from "$lib/components/TopMenu.svelte";
  import type { CommitFile, CommitInfo, RepositorySnapshot } from "$lib/types/repository";

  let repositoryPath = $state("");
  let snapshot = $state<RepositorySnapshot | null>(null);
  let selectedCommit = $state<CommitInfo | null>(null);
  let selectedFile = $state<CommitFile | null>(null);
  let error = $state("");
  let loading = $state(false);

  async function openRepository(event: Event) {
    event.preventDefault();
    error = "";
    loading = true;

    try {
      snapshot = await invoke<RepositorySnapshot>("load_repository", {
        path: repositoryPath.trim(),
      });
      repositoryPath = snapshot.info.root;
      selectedCommit = snapshot.commits[0] ?? null;
      selectedFile = null;
    } catch (caught) {
      snapshot = null;
      selectedCommit = null;
      selectedFile = null;
      error = formatError(caught);
    } finally {
      loading = false;
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

  function selectCommit(commit: CommitInfo) {
    selectedCommit = commit;
    selectedFile = null;
  }

  function selectFile(file: CommitFile) {
    selectedFile = file;
  }

  function closeDiff() {
    selectedFile = null;
  }
</script>

<main class="grid h-screen min-h-0 grid-rows-[auto_1fr] bg-white text-[#202124]">
  <TopMenu bind:repositoryPath {snapshot} {loading} {error} onOpenRepository={openRepository} />

  <section class="grid min-h-0 grid-cols-1 overflow-hidden lg:grid-cols-[230px_minmax(0,1fr)_360px] xl:grid-cols-[230px_minmax(0,1fr)_430px]">
    {#if snapshot && selectedCommit && selectedFile}
      <div class="h-full min-h-0 lg:col-span-2">
        <CommitFileDiffViewer
          {snapshot}
          {selectedCommit}
          {selectedFile}
          onClose={closeDiff}
        />
      </div>
    {:else}
      <Sidebar {snapshot} />
      <GitGraph {snapshot} {selectedCommit} onSelectCommit={selectCommit} />
    {/if}
    <DetailsPanel {snapshot} {selectedCommit} {selectedFile} onSelectFile={selectFile} />
  </section>
</main>
