<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import CommitDetailsPanel from "$lib/components/CommitDetailsPanel.svelte";
  import CommitFileDiffViewer from "$lib/components/CommitFileDiffViewer.svelte";
  import EmptyDetailsPanel from "$lib/components/EmptyDetailsPanel.svelte";
  import GitGraph from "$lib/components/GitGraph.svelte";
  import RepositoryDetailsPanel from "$lib/components/RepositoryDetailsPanel.svelte";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import TopMenu from "$lib/components/TopMenu.svelte";
  import WorkingTreePanel from "$lib/components/WorkingTreePanel.svelte";
  import type { CommitFile, CommitInfo, RepositorySnapshot } from "$lib/types/repository";

  type SelectedGraphItem = { type: "changes" } | { type: "commit"; commit: CommitInfo };

  let repositoryPath = $state("");
  let snapshot = $state<RepositorySnapshot | null>(null);
  let selectedGraphItem = $state<SelectedGraphItem | null>(null);
  let selectedFile = $state<CommitFile | null>(null);
  let error = $state("");
  let loading = $state(false);
  const selectedCommit = $derived(
    selectedGraphItem?.type === "commit" ? selectedGraphItem.commit : null,
  );
  const changesSelected = $derived(selectedGraphItem?.type === "changes");

  async function openRepository(event: Event) {
    event.preventDefault();
    error = "";
    loading = true;

    try {
      snapshot = await invoke<RepositorySnapshot>("load_repository", {
        path: repositoryPath.trim(),
      });
      repositoryPath = snapshot.info.root;
      selectedGraphItem = snapshot.status.changedFiles.length
        ? { type: "changes" }
        : snapshot.commits[0]
          ? { type: "commit", commit: snapshot.commits[0] }
          : null;
      selectedFile = null;
    } catch (caught) {
      snapshot = null;
      selectedGraphItem = null;
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
    selectedGraphItem = { type: "commit", commit };
    selectedFile = null;
  }

  function selectChanges() {
    selectedGraphItem = { type: "changes" };
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
    {#if snapshot && selectedFile && (selectedCommit || changesSelected)}
      <div class="h-full min-h-0 lg:col-span-2">
        <CommitFileDiffViewer
          {snapshot}
          diffSource={changesSelected ? "workingTree" : "commit"}
          selectedCommit={selectedCommit}
          {selectedFile}
          onClose={closeDiff}
        />
      </div>
    {:else}
      <Sidebar {snapshot} />
      <GitGraph
        {snapshot}
        {selectedCommit}
        {changesSelected}
        onSelectChanges={selectChanges}
        onSelectCommit={selectCommit}
      />
    {/if}
    {#if snapshot && changesSelected}
      <WorkingTreePanel {snapshot} {selectedFile} onSelectFile={selectFile} />
    {:else if snapshot && selectedCommit}
      <CommitDetailsPanel {snapshot} {selectedCommit} {selectedFile} onSelectFile={selectFile} />
    {:else if snapshot}
      <RepositoryDetailsPanel {snapshot} />
    {:else}
      <EmptyDetailsPanel />
    {/if}
  </section>
</main>
