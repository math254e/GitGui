<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { open } from "@tauri-apps/plugin-dialog";
  import { onDestroy, onMount } from "svelte";
  import CommitDetailsPanel from "$lib/components/CommitDetailsPanel.svelte";
  import CommitFileDiffViewer from "$lib/components/CommitFileDiffViewer.svelte";
  import EmptyDetailsPanel from "$lib/components/EmptyDetailsPanel.svelte";
  import GitGraph from "$lib/components/GitGraph.svelte";
  import ResizablePaneGroup, { type ResizablePane } from "$lib/components/ResizablePaneGroup.svelte";
  import RepositoryDetailsPanel from "$lib/components/RepositoryDetailsPanel.svelte";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import StartView from "$lib/components/StartView.svelte";
  import TopMenu, { type RepoTab } from "$lib/components/TopMenu.svelte";
  import WorkingTreePanel from "$lib/components/WorkingTreePanel.svelte";
  import type { CommitFile, CommitInfo, RepositorySnapshot } from "$lib/types/repository";

  type ActiveView = "start" | "repo";
  type SelectedGraphItem = { type: "changes" } | { type: "commit"; commit: CommitInfo };
  type LayoutStorage = {
    sidebarWidth?: number;
    detailsWidth?: number;
  };
  type WorkspaceStorage = {
    openRepoPaths?: string[];
    activeRepoPath?: string | null;
    recentRepos?: RecentRepo[];
  };
  type WorkspaceRepo = {
    id: string;
    title: string;
    snapshot: RepositorySnapshot;
    selectedGraphItem: SelectedGraphItem | null;
    selectedFile: CommitFile | null;
    loading: boolean;
    error: string;
    refreshRequest: number;
  };
  type RecentRepo = {
    root: string;
    title: string;
  };

  const layoutStorageKey = "gitgui.workspaceLayout.v1";
  const workspaceStorageKey = "gitgui.workspaceState.v1";
  const maxRecentRepos = 10;
  const autoRefreshMs = 30_000;
  const sidebarLimits = { default: 230, min: 180, max: 420 };
  const detailsLimits = { default: 430, min: 300, max: 620 };

  let activeView = $state<ActiveView>("start");
  let activeRepoId = $state<string | null>(null);
  let openRepos = $state<WorkspaceRepo[]>([]);
  let recentRepos = $state<RecentRepo[]>([]);
  let startError = $state("");
  let openingPath = $state<string | null>(null);
  let restoreLoading = $state(false);
  let sidebarWidth = $state(sidebarLimits.default);
  let detailsWidth = $state(detailsLimits.default);
  let activeOpenRequest = 0;
  let activeRefreshRequest = 0;
  let persistenceReady = false;
  let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;

  const activeRepo = $derived(openRepos.find((repo) => repo.id === activeRepoId) ?? null);
  const snapshot = $derived(activeRepo?.snapshot ?? null);
  const selectedGraphItem = $derived(activeRepo?.selectedGraphItem ?? null);
  const selectedFile = $derived(activeRepo?.selectedFile ?? null);
  const selectedCommit = $derived(
    selectedGraphItem?.type === "commit" ? selectedGraphItem.commit : null,
  );
  const changesSelected = $derived(selectedGraphItem?.type === "changes");
  const repoTabs = $derived<RepoTab[]>(
    openRepos.map((repo) => ({
      id: repo.id,
      title: repo.title,
      root: repo.snapshot.info.root,
      branch: repo.snapshot.status.currentBranch ?? "Detached HEAD",
      loading: repo.loading,
      error: repo.error,
    })),
  );
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
    void restoreWorkspace();
    autoRefreshTimer = setInterval(refreshOpenRepositories, autoRefreshMs);
    window.addEventListener("pagehide", persistWorkspace);
    window.addEventListener("beforeunload", persistWorkspace);
    window.addEventListener("focus", refreshOpenRepositories);
    document.addEventListener("visibilitychange", refreshWhenVisible);
  });

  onDestroy(() => {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
    }

    window.removeEventListener("pagehide", persistWorkspace);
    window.removeEventListener("beforeunload", persistWorkspace);
    window.removeEventListener("focus", refreshOpenRepositories);
    document.removeEventListener("visibilitychange", refreshWhenVisible);
  });

  async function chooseRepository() {
    startError = "";

    try {
      const selectedPath = await open({
        directory: true,
        multiple: false,
        title: "Open repository",
      });

      if (typeof selectedPath === "string") {
        await openRepositoryPath(selectedPath);
      }
    } catch (caught) {
      startError = formatError(caught);
    }
  }

  async function openRepositoryPath(path: string) {
    if (!path) {
      return;
    }

    const request = ++activeOpenRequest;
    startError = "";
    openingPath = path;

    try {
      const nextSnapshot = await invoke<RepositorySnapshot>("load_repository", { path });

      if (request !== activeOpenRequest) {
        return;
      }

      upsertRepository(nextSnapshot);
    } catch (caught) {
      if (request === activeOpenRequest) {
        startError = formatError(caught);
      }
    } finally {
      if (request === activeOpenRequest) {
        openingPath = null;
      }
    }
  }

  function upsertRepository(nextSnapshot: RepositorySnapshot) {
    const id = nextSnapshot.info.root;
    const existingIndex = openRepos.findIndex((repo) => repo.id === id);

    if (existingIndex >= 0) {
      openRepos = openRepos.map((repo) =>
        repo.id === id
          ? {
              ...repo,
              title: repoTitle(nextSnapshot.info.root),
              snapshot: nextSnapshot,
              error: "",
              loading: false,
              refreshRequest: repo.refreshRequest,
            }
          : repo,
      );
    } else {
      openRepos = [
        ...openRepos,
        {
          id,
          title: repoTitle(nextSnapshot.info.root),
          snapshot: nextSnapshot,
          selectedGraphItem: initialGraphSelection(nextSnapshot),
          selectedFile: null,
          loading: false,
          error: "",
          refreshRequest: 0,
        },
      ];
    }

    addRecentRepo(nextSnapshot);
    activeRepoId = id;
    activeView = "repo";
    persistWorkspace();
  }

  function initialGraphSelection(nextSnapshot: RepositorySnapshot): SelectedGraphItem | null {
    if (nextSnapshot.status.changedFiles.length) {
      return { type: "changes" };
    }

    return nextSnapshot.commits[0] ? { type: "commit", commit: nextSnapshot.commits[0] } : null;
  }

  function addRecentRepo(nextSnapshot: RepositorySnapshot) {
    const recentRepo = {
      root: nextSnapshot.info.root,
      title: repoTitle(nextSnapshot.info.root),
    };
    recentRepos = [
      recentRepo,
      ...recentRepos.filter((repo) => repo.root !== recentRepo.root),
    ].slice(0, maxRecentRepos);
  }

  async function restoreWorkspace() {
    const stored = localStorage.getItem(workspaceStorageKey);
    persistenceReady = false;

    if (!stored) {
      persistenceReady = true;
      return;
    }

    try {
      const parsed = JSON.parse(stored) as WorkspaceStorage;
      recentRepos = normalizeRecentRepos(parsed.recentRepos);
      const paths = Array.isArray(parsed.openRepoPaths) ? parsed.openRepoPaths.filter(Boolean) : [];

      if (!paths.length) {
        persistenceReady = true;
        return;
      }

      restoreLoading = true;
      const restoredRepos: WorkspaceRepo[] = [];

      for (const path of paths) {
        try {
          const nextSnapshot = await invoke<RepositorySnapshot>("load_repository", { path });
          restoredRepos.push({
            id: nextSnapshot.info.root,
            title: repoTitle(nextSnapshot.info.root),
            snapshot: nextSnapshot,
            selectedGraphItem: initialGraphSelection(nextSnapshot),
            selectedFile: null,
            loading: false,
            error: "",
            refreshRequest: 0,
          });
          addRecentRepo(nextSnapshot);
        } catch {
          // Skip repositories that are no longer available.
        }
      }

      openRepos = dedupeRepos(restoredRepos);
      activeRepoId =
        openRepos.find((repo) => repo.id === parsed.activeRepoPath)?.id ?? openRepos[0]?.id ?? null;
      activeView = activeRepoId ? "repo" : "start";
    } catch {
      localStorage.removeItem(workspaceStorageKey);
      activeView = "start";
      activeRepoId = null;
    } finally {
      restoreLoading = false;
      persistenceReady = true;
      persistWorkspace();
    }
  }

  function normalizeRecentRepos(storedRecentRepos: RecentRepo[] | undefined) {
    if (!Array.isArray(storedRecentRepos)) {
      return [];
    }

    const normalized: RecentRepo[] = [];

    for (const repo of storedRecentRepos) {
      if (!repo?.root || normalized.some((item) => item.root === repo.root)) {
        continue;
      }

      normalized.push({
        root: repo.root,
        title: repo.title || repoTitle(repo.root),
      });
    }

    return normalized.slice(0, maxRecentRepos);
  }

  function dedupeRepos(repos: WorkspaceRepo[]) {
    return repos.filter((repo, index) => repos.findIndex((candidate) => candidate.id === repo.id) === index);
  }

  function persistWorkspace() {
    localStorage.setItem(
      workspaceStorageKey,
      JSON.stringify({
        openRepoPaths: openRepos.map((repo) => repo.snapshot.info.root),
        activeRepoPath: activeRepoId,
        recentRepos,
      } satisfies WorkspaceStorage),
    );
  }

  function refreshWhenVisible() {
    if (document.visibilityState === "visible") {
      void refreshOpenRepositories();
    }
  }

  async function refreshOpenRepositories() {
    if (!openRepos.length || restoreLoading) {
      return;
    }

    const repoIds = openRepos.map((repo) => repo.id);

    await Promise.all(repoIds.map((repoId) => refreshRepository(repoId)));
  }

  async function refreshRepository(repoId: string) {
    const repo = openRepos.find((candidate) => candidate.id === repoId);

    if (!repo || repo.refreshRequest) {
      return;
    }

    const request = ++activeRefreshRequest;
    openRepos = openRepos.map((candidate) =>
      candidate.id === repoId
        ? {
            ...candidate,
            refreshRequest: request,
          }
        : candidate,
    );

    try {
      const nextSnapshot = await invoke<RepositorySnapshot>("load_repository", {
        path: repo.snapshot.info.root,
      });

      openRepos = openRepos.map((candidate) => {
        if (candidate.id !== repoId || candidate.refreshRequest !== request) {
          return candidate;
        }

        return {
          ...candidate,
          title: repoTitle(nextSnapshot.info.root),
          snapshot: nextSnapshot,
          selectedGraphItem: reconcileSelection(candidate.selectedGraphItem, nextSnapshot),
          selectedFile: reconcileSelectedFile(candidate.selectedFile, nextSnapshot),
          error: "",
          refreshRequest: 0,
        };
      });
    } catch (caught) {
      openRepos = openRepos.map((candidate) =>
        candidate.id === repoId && candidate.refreshRequest === request
          ? {
              ...candidate,
              error: formatError(caught),
              refreshRequest: 0,
            }
          : candidate,
      );
    }
  }

  function reconcileSelection(
    currentSelection: SelectedGraphItem | null,
    nextSnapshot: RepositorySnapshot,
  ): SelectedGraphItem | null {
    if (currentSelection?.type === "commit") {
      const matchingCommit = nextSnapshot.commits.find((commit) => commit.hash === currentSelection.commit.hash);

      if (matchingCommit) {
        return { type: "commit", commit: matchingCommit };
      }
    }

    if (currentSelection?.type === "changes" && nextSnapshot.status.changedFiles.length) {
      return { type: "changes" };
    }

    return initialGraphSelection(nextSnapshot);
  }

  function reconcileSelectedFile(currentFile: CommitFile | null, nextSnapshot: RepositorySnapshot) {
    if (!currentFile) {
      return null;
    }

    const stillChanged = nextSnapshot.status.changedFiles.some((file) => file.path === currentFile.path);
    return stillChanged ? currentFile : null;
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

  function showStartView() {
    activeView = "start";
    persistWorkspace();
  }

  function selectRepo(repoId: string) {
    activeRepoId = repoId;
    activeView = "repo";
    persistWorkspace();
  }

  function closeRepo(repoId: string) {
    const repoIndex = openRepos.findIndex((repo) => repo.id === repoId);

    if (repoIndex === -1) {
      return;
    }

    const wasActive = activeRepoId === repoId;
    const wasVisibleActive = activeView === "repo" && wasActive;
    openRepos = openRepos.filter((repo) => repo.id !== repoId);

    if (!wasActive) {
      persistWorkspace();
      return;
    }

    const nextRepo = openRepos[Math.min(repoIndex, openRepos.length - 1)] ?? null;
    activeRepoId = nextRepo?.id ?? null;

    if (wasVisibleActive) {
      activeView = nextRepo ? "repo" : "start";
    }

    persistWorkspace();
  }

  function selectCommit(commit: CommitInfo) {
    updateActiveRepo((repo) => ({
      ...repo,
      selectedGraphItem: { type: "commit", commit },
      selectedFile: null,
    }));
  }

  function selectChanges() {
    updateActiveRepo((repo) => ({
      ...repo,
      selectedGraphItem: { type: "changes" },
      selectedFile: null,
    }));
  }

  function selectFile(file: CommitFile) {
    updateActiveRepo((repo) => ({
      ...repo,
      selectedFile: file,
    }));
  }

  function closeDiff() {
    updateActiveRepo((repo) => ({
      ...repo,
      selectedFile: null,
    }));
  }

  function updateActiveRepo(update: (repo: WorkspaceRepo) => WorkspaceRepo) {
    if (!activeRepoId) {
      return;
    }

    openRepos = openRepos.map((repo) => (repo.id === activeRepoId ? update(repo) : repo));
  }

  function repoTitle(path: string) {
    const normalized = path.replace(/[\\/]+$/, "");
    return normalized.split(/[\\/]/).pop() || normalized || "Repository";
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
  <TopMenu
    activeView={activeView}
    {activeRepoId}
    tabs={repoTabs}
    onShowStart={showStartView}
    onSelectRepo={selectRepo}
    onCloseRepo={closeRepo}
  />

  <section class="min-h-0 overflow-hidden">
    {#if activeView === "start" || !activeRepo}
      <StartView
        recentRepos={recentRepos}
        loading={Boolean(openingPath) || restoreLoading}
        error={startError}
        onChooseRepository={chooseRepository}
        onOpenRecent={openRepositoryPath}
      />
    {:else}
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
    {/if}
  </section>
</main>
