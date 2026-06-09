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
  type BackendWorkspaceRepo = {
    id: string;
    title: string;
    snapshot: RepositorySnapshot;
    error?: string | null;
  };
  type WorkspaceRepo = BackendWorkspaceRepo & {
    selectedGraphItem: SelectedGraphItem | null;
    selectedFile: CommitFile | null;
  };
  type RecentRepo = {
    root: string;
    title: string;
    snapshot?: RepositorySnapshot;
  };
  type WorkspaceSnapshot = {
    activeRepoId?: string | null;
    openRepos: BackendWorkspaceRepo[];
    recentRepos: RecentRepo[];
  };

  const layoutStorageKey = "gitgui.workspaceLayout.v1";
  const legacyWorkspaceStorageKey = "gitgui.workspaceState.v1";
  const autoRefreshMs = 30_000;
  const initialPrefetchCommitCount = 20;
  const sidebarLimits = { default: 230, min: 180, max: 420 };
  const detailsLimits = { default: 430, min: 300, max: 620 };

  let activeView = $state<ActiveView>("start");
  let activeRepoId = $state<string | null>(null);
  let openRepos = $state<WorkspaceRepo[]>([]);
  let recentRepos = $state<RecentRepo[]>([]);
  let startError = $state("");
  let opening = $state(false);
  let restoring = $state(false);
  let largeScreen = $state(false);
  let sidebarWidth = $state(sidebarLimits.default);
  let detailsWidth = $state(detailsLimits.default);
  let activeWorkspaceRequest = 0;
  let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let largeScreenMediaQuery: MediaQueryList | null = null;
  const prefetchedInitialCommits = new Map<string, string>();
  const prefetchedCommitDiffs = new Set<string>();

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
      loading: false,
      error: repo.error ?? "",
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
    largeScreenMediaQuery = window.matchMedia("(min-width: 1024px)");
    largeScreen = largeScreenMediaQuery.matches;
    largeScreenMediaQuery.addEventListener("change", updateLargeScreen);
    void restoreWorkspace();
    autoRefreshTimer = setInterval(refreshOpenRepositories, autoRefreshMs);
    window.addEventListener("focus", refreshOpenRepositories);
    document.addEventListener("visibilitychange", refreshWhenVisible);
  });

  onDestroy(() => {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
    }

    window.removeEventListener("focus", refreshOpenRepositories);
    document.removeEventListener("visibilitychange", refreshWhenVisible);
    largeScreenMediaQuery?.removeEventListener("change", updateLargeScreen);
  });

  function updateLargeScreen(event: MediaQueryListEvent) {
    largeScreen = event.matches;
  }

  async function restoreWorkspace() {
    restoring = true;

    try {
      let workspace = await invoke<WorkspaceSnapshot>("restore_workspace");

      if (!workspace.openRepos.length && !workspace.recentRepos.length) {
        const legacyWorkspace = readLegacyWorkspace();

        if (legacyWorkspace) {
          workspace = await invoke<WorkspaceSnapshot>("import_legacy_workspace", {
            legacyState: legacyWorkspace,
          });
          localStorage.removeItem(legacyWorkspaceStorageKey);
        }
      }

      applyWorkspace(workspace);
      activeView = activeRepoId ? "repo" : "start";
    } catch (caught) {
      startError = formatError(caught);
      activeView = "start";
    } finally {
      restoring = false;
    }
  }

  function readLegacyWorkspace() {
    const stored = localStorage.getItem(legacyWorkspaceStorageKey);

    if (!stored) {
      return null;
    }

    try {
      return JSON.parse(stored);
    } catch {
      localStorage.removeItem(legacyWorkspaceStorageKey);
      return null;
    }
  }

  async function chooseRepository() {
    startError = "";

    try {
      const selectedPath = await open({
        directory: true,
        multiple: false,
        title: "Open repository",
      });

      if (typeof selectedPath === "string") {
        await runWorkspaceCommand(() =>
          invoke<WorkspaceSnapshot>("open_workspace_repository", { path: selectedPath }),
        );
      }
    } catch (caught) {
      startError = formatError(caught);
    }
  }

  async function openRecentRepository(root: string) {
    await runWorkspaceCommand(() =>
      invoke<WorkspaceSnapshot>("open_recent_workspace_repository", { root }),
    );
    void refreshRepository(root);
  }

  async function selectRepo(repoId: string) {
    await runWorkspaceCommand(() =>
      invoke<WorkspaceSnapshot>("select_workspace_repository", { repoId }),
    );
  }

  async function closeRepo(repoId: string) {
    const wasVisibleActive = activeView === "repo" && activeRepoId === repoId;
    await runWorkspaceCommand(() =>
      invoke<WorkspaceSnapshot>("close_workspace_repository", { repoId }),
    );

    if (wasVisibleActive) {
      activeView = activeRepoId ? "repo" : "start";
    }
  }

  async function removeRecentRepo(root: string) {
    await runWorkspaceCommand(() =>
      invoke<WorkspaceSnapshot>("remove_recent_workspace_repository", { root }),
    );

    if (!activeRepoId) {
      activeView = "start";
    }
  }

  async function runWorkspaceCommand(loadWorkspace: () => Promise<WorkspaceSnapshot>) {
    const request = ++activeWorkspaceRequest;
    opening = true;
    startError = "";

    try {
      const workspace = await loadWorkspace();

      if (request === activeWorkspaceRequest) {
        applyWorkspace(workspace);
        activeView = activeRepoId ? "repo" : activeView;
      }
    } catch (caught) {
      if (request === activeWorkspaceRequest) {
        startError = formatError(caught);
      }
    } finally {
      if (request === activeWorkspaceRequest) {
        opening = false;
      }
    }
  }

  function applyWorkspace(workspace: WorkspaceSnapshot) {
    const previousRepos = openRepos;
    activeRepoId = workspace.activeRepoId ?? null;
    recentRepos = workspace.recentRepos;
    openRepos = workspace.openRepos.map((repo) => {
      const previousRepo = previousRepos.find((candidate) => candidate.id === repo.id);
      const selectedGraphItem = reconcileSelection(previousRepo?.selectedGraphItem ?? null, repo.snapshot);

      return {
        ...repo,
        selectedGraphItem,
        selectedFile: reconcileSelectedFile(previousRepo?.selectedFile ?? null, repo.snapshot),
      };
    });
    prunePrefetchState(openRepos);
    prefetchInitialCommitFiles(openRepos);
  }

  function prunePrefetchState(repos: WorkspaceRepo[]) {
    const openRepoIds = new Set(repos.map((repo) => repo.id));

    for (const repoId of prefetchedInitialCommits.keys()) {
      if (!openRepoIds.has(repoId)) {
        prefetchedInitialCommits.delete(repoId);
      }
    }

    for (const signature of prefetchedCommitDiffs) {
      const isOpenRepoSignature = repos.some((repo) => signature.startsWith(`${repo.id}:`));

      if (!isOpenRepoSignature) {
        prefetchedCommitDiffs.delete(signature);
      }
    }
  }

  function prefetchInitialCommitFiles(repos: WorkspaceRepo[]) {
    for (const repo of repos) {
      const commitHashes = repo.snapshot.commits
        .slice(0, initialPrefetchCommitCount)
        .map((commit) => commit.hash);

      if (!commitHashes.length) {
        continue;
      }

      const signature = commitHashes.join(":");

      if (prefetchedInitialCommits.get(repo.id) === signature) {
        continue;
      }

      prefetchedInitialCommits.set(repo.id, signature);
      void invoke("prefetch_first_commit_files", {
        repoRoot: repo.snapshot.info.root,
        commitHashes,
      }).catch(() => {
        prefetchedInitialCommits.delete(repo.id);
      });
    }
  }

  function refreshWhenVisible() {
    if (document.visibilityState === "visible") {
      void refreshOpenRepositories();
    }
  }

  async function refreshOpenRepositories() {
    if (!openRepos.length || restoring) {
      return;
    }

    try {
      applyWorkspace(await invoke<WorkspaceSnapshot>("refresh_workspace_repositories"));
    } catch {
      // Refresh errors are returned as per-repo tab errors when possible.
    }
  }

  async function refreshRepository(repoId: string) {
    if (!openRepos.some((repo) => repo.id === repoId)) {
      return;
    }

    try {
      applyWorkspace(await invoke<WorkspaceSnapshot>("refresh_workspace_repository", { repoId }));
    } catch {
      // Refresh errors are returned as per-repo tab errors when possible.
    }
  }

  function initialGraphSelection(nextSnapshot: RepositorySnapshot): SelectedGraphItem | null {
    if (nextSnapshot.status.changedFiles.length) {
      return { type: "changes" };
    }

    return nextSnapshot.commits[0] ? { type: "commit", commit: nextSnapshot.commits[0] } : null;
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
  }

  function selectCommit(commit: CommitInfo) {
    if (snapshot) {
      prefetchCommitDiffs(snapshot.info.root, commit);
    }

    updateActiveRepo((repo) => ({
      ...repo,
      selectedGraphItem: { type: "commit", commit },
      selectedFile: null,
    }));
  }

  function prefetchCommitDiffs(repositoryPath: string, commit: CommitInfo) {
    const parentHash = commit.parents[0] ?? null;
    const signature = `${repositoryPath}:${commit.hash}:${parentHash ?? ""}`;

    if (prefetchedCommitDiffs.has(signature)) {
      return;
    }

    prefetchedCommitDiffs.add(signature);
    void invoke("prefetch_commit_file_diffs", {
      path: repositoryPath,
      commitHash: commit.hash,
      parentHash,
    }).catch(() => {
      prefetchedCommitDiffs.delete(signature);
    });
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
        loading={opening || restoring}
        error={startError}
        onChooseRepository={chooseRepository}
        onOpenRecent={openRecentRepository}
        onRemoveRecent={removeRecentRepo}
      />
    {:else}
      {#if !largeScreen}
      <div class="grid h-full min-h-0 grid-cols-1 overflow-hidden">
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
      {:else}
      <div class="h-full min-h-0">
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
    {/if}
  </section>
</main>
