<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { onMount } from "svelte";
  import CommitDetailsPanel from "$lib/components/CommitDetailsPanel.svelte";
  import CommitFileDiffViewer from "$lib/components/CommitFileDiffViewer.svelte";
  import EmptyDetailsPanel from "$lib/components/EmptyDetailsPanel.svelte";
  import GitGraph from "$lib/components/GitGraph.svelte";
  import ResizablePaneGroup, { type ResizablePane } from "$lib/components/ResizablePaneGroup.svelte";
  import RepositoryDetailsPanel from "$lib/components/RepositoryDetailsPanel.svelte";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import TopMenu from "$lib/components/TopMenu.svelte";
  import WorkingTreePanel from "$lib/components/WorkingTreePanel.svelte";
  import type { CommitFile, CommitInfo, RepositorySnapshot } from "$lib/types/repository";

  type SelectedGraphItem = { type: "changes" } | { type: "commit"; commit: CommitInfo };
  type LayoutStorage = {
    sidebarWidth?: number;
    detailsWidth?: number;
  };

  const layoutStorageKey = "gitgui.workspaceLayout.v1";
  const sidebarLimits = { default: 230, min: 180, max: 420 };
  const detailsLimits = { default: 430, min: 300, max: 620 };

  let repositoryPath = $state("");
  let snapshot = $state<RepositorySnapshot | null>(null);
  let selectedGraphItem = $state<SelectedGraphItem | null>(null);
  let selectedFile = $state<CommitFile | null>(null);
  let error = $state("");
  let loading = $state(false);
  let sidebarWidth = $state(sidebarLimits.default);
  let detailsWidth = $state(detailsLimits.default);
  const selectedCommit = $derived(
    selectedGraphItem?.type === "commit" ? selectedGraphItem.commit : null,
  );
  const changesSelected = $derived(selectedGraphItem?.type === "changes");
  const detailsPane = $derived<ResizablePane>({
    id: "details",
    minWidth: detailsLimits.min,
    maxWidth: detailsLimits.max,
    width: detailsWidth,
  });
  const graphPanes = $derived<ResizablePane[]>([
    {
      id: "sidebar",
      minWidth: sidebarLimits.min,
      maxWidth: sidebarLimits.max,
      width: sidebarWidth,
    },
    {
      id: "graph",
      minWidth: 320,
      flexible: true,
    },
    detailsPane,
  ]);
  const diffPanes = $derived<ResizablePane[]>([
    {
      id: "diff",
      minWidth: 420,
      flexible: true,
    },
    detailsPane,
  ]);

  onMount(() => {
    restoreLayout();
  });

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

  function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, Math.round(value)));
  }

  function restoreLayout() {
    const stored = localStorage.getItem(layoutStorageKey);

    if (!stored) {
      return;
    }

    try {
      const parsed = JSON.parse(stored) as LayoutStorage;

      if (typeof parsed.sidebarWidth === "number") {
        sidebarWidth = clamp(parsed.sidebarWidth, sidebarLimits.min, sidebarLimits.max);
      }

      if (typeof parsed.detailsWidth === "number") {
        detailsWidth = clamp(parsed.detailsWidth, detailsLimits.min, detailsLimits.max);
      }
    } catch {
      localStorage.removeItem(layoutStorageKey);
    }
  }

  function persistLayout() {
    localStorage.setItem(
      layoutStorageKey,
      JSON.stringify({
        sidebarWidth,
        detailsWidth,
      } satisfies LayoutStorage),
    );
  }

  function resizePane(id: string, width: number) {
    if (id === "sidebar") {
      sidebarWidth = clamp(width, sidebarLimits.min, sidebarLimits.max);
    }

    if (id === "details") {
      detailsWidth = clamp(width, detailsLimits.min, detailsLimits.max);
    }

    persistLayout();
  }
</script>

<main class="grid h-screen min-h-0 grid-rows-[auto_1fr] bg-white text-[#202124]">
  <TopMenu bind:repositoryPath {snapshot} {loading} {error} onOpenRepository={openRepository} />

  <section class="min-h-0 overflow-hidden">
    <div class="grid h-full min-h-0 grid-cols-1 overflow-hidden lg:hidden">
      {#if snapshot && selectedFile && (selectedCommit || changesSelected)}
        <div class="h-full min-h-0">
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
    </div>

    <div class="hidden h-full min-h-0 lg:block">
      {#if snapshot && selectedFile && (selectedCommit || changesSelected)}
        <ResizablePaneGroup panes={diffPanes} onResize={resizePane}>
          {#snippet pane0()}
            <CommitFileDiffViewer
              snapshot={snapshot!}
              diffSource={changesSelected ? "workingTree" : "commit"}
              selectedCommit={selectedCommit}
              selectedFile={selectedFile!}
              onClose={closeDiff}
            />
          {/snippet}

          {#snippet pane1()}
            {#if changesSelected}
              <WorkingTreePanel snapshot={snapshot!} {selectedFile} onSelectFile={selectFile} />
            {:else if selectedCommit}
              <CommitDetailsPanel snapshot={snapshot!} {selectedCommit} {selectedFile} onSelectFile={selectFile} />
            {/if}
          {/snippet}
        </ResizablePaneGroup>
      {:else}
        <ResizablePaneGroup panes={graphPanes} onResize={resizePane}>
          {#snippet pane0()}
            <Sidebar {snapshot} />
          {/snippet}

          {#snippet pane1()}
            <GitGraph
              {snapshot}
              {selectedCommit}
              {changesSelected}
              onSelectChanges={selectChanges}
              onSelectCommit={selectCommit}
            />
          {/snippet}

          {#snippet pane2()}
            {#if snapshot && changesSelected}
              <WorkingTreePanel {snapshot} {selectedFile} onSelectFile={selectFile} />
            {:else if snapshot && selectedCommit}
              <CommitDetailsPanel {snapshot} {selectedCommit} {selectedFile} onSelectFile={selectFile} />
            {:else if snapshot}
              <RepositoryDetailsPanel {snapshot} />
            {:else}
              <EmptyDetailsPanel />
            {/if}
          {/snippet}
        </ResizablePaneGroup>
      {/if}
    </div>
  </section>
</main>
