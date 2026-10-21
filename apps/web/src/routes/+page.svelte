<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { toast } from "svelte-sonner";
  import {
    type ClientWorkspace,
    type GitGuiClient,
    type ClientWorkspaceState,
  } from "$lib/client-runtime";
  import { useWebApplicationRuntime, type WebApplicationRuntimeState } from "$lib/connection/runtime";
  import CommitDetailsPanel from "$lib/components/CommitDetailsPanel.svelte";
  import CommitFileDiffViewer from "$lib/components/CommitFileDiffViewer.svelte";
  import CreateRepositoryView, {
    type CreateRepositoryProvider,
  } from "$lib/components/CreateRepositoryView.svelte";
  import EmptyDetailsPanel from "$lib/components/EmptyDetailsPanel.svelte";
  import GitActionStatusBar from "$lib/components/GitActionStatusBar.svelte";
  import GitGraph from "$lib/components/GitGraph.svelte";
  import DiscardChangesDialog from "$lib/components/DiscardChangesDialog.svelte";
  import GitNameDialog from "$lib/components/GitNameDialog.svelte";
  import HistoryToolbar from "$lib/components/HistoryToolbar.svelte";
  import ResizablePaneGroup, { type ResizablePane } from "$lib/components/ResizablePaneGroup.svelte";
  import RepositoryDetailsPanel from "$lib/components/RepositoryDetailsPanel.svelte";
  import RepositoryPathDialog from "$lib/components/RepositoryPathDialog.svelte";
  import SettingsView from "$lib/components/SettingsView.svelte";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import StartView from "$lib/components/StartView.svelte";
  import TopMenu, { type RepoTab } from "$lib/components/TopMenu.svelte";
  import WorkingTreePanel, {
    type CommitMessageDraft,
    type WorkingTreeDraftState,
    type WorkingTreeDiffSource,
  } from "$lib/components/WorkingTreePanel.svelte";
  import type { ChangedFile, RepositorySummary, GitAmendInfo, GitDiscardFile, GitApplyHunksParams } from "@gitgui/contracts";
  import type { CommitFile, CommitInfo, CommitRef, RepositorySnapshot } from "$lib/types/repository";
  import { graphRefKey, isCurrentBranchRef } from "$lib/types/branch-visibility";
  import { readBranchSwitchMergePreference, resolveProjectsLocation } from "$lib/preferences";
  import { reconcileWorkingTreeFile } from "$lib/client-runtime/file-selection";

  type ActiveView = "start" | "repo" | "settings" | "create";
  type SelectedGraphItem = { type: "changes" } | { type: "commit"; commit: CommitInfo };
  type LayoutStorage = {
    sidebarWidth?: number;
    detailsWidth?: number;
  };
  type BackendWorkspaceRepo = {
    id: string;
    title: string;
    root: string;
    isWorktree: boolean;
    snapshot?: RepositorySnapshot;
    error?: string | null;
    loading: boolean;
  };
  type WorkspaceRepo = BackendWorkspaceRepo & {
    selectedGraphItem: SelectedGraphItem | null;
    selectedFile: CommitFile | null;
    selectedFileSource: WorkingTreeDiffSource | null;
    selectedChangePaths: string[];
    selectedChangeSource: WorkingTreeDiffSource | null;
  };
  type FilteredGraphView = {
    repositoryId: string;
    key: string;
    refs: CommitRef[];
    commits: RepositorySnapshot["commits"];
    graph: RepositorySnapshot["graph"];
    sourceGraph: RepositorySnapshot["graph"];
  };
  type RepositoryListItem = {
    repositoryId: string;
    root: string;
    title: string;
  };
  type GitActionKind =
    | "stage"
    | "unstage"
    | "commit"
    | "amend"
    | "discard"
    | "fetch"
    | "pull"
    | "push"
    | "switchBranch"
    | "createBranch"
    | "stash"
    | "stashPop";
  type GitActionRequest = {
    kind: GitActionKind;
    label: string;
    action: (repositoryId: string) => Promise<unknown>;
    successMessage?: string;
    notifySuccess?: boolean;
    onApplied?: () => void;
  };
  type PendingGitAction = GitActionRequest & {
    repositoryId: string;
  };

  const layoutStorageKey = "gitgui.workspaceLayout.v1";
  const branchGraphVisibilityStoragePrefix = "gitgui.branchGraphVisibility.v1";
  const initialPrefetchCommitCount = 20;
  const sidebarLimits = { default: 230, min: 180, max: 420 };
  const detailsLimits = { default: 430, min: 300, max: 620 };

  let activeView = $state<ActiveView>("start");
  let activeRepoId = $state<string | null>(null);
  let openRepos = $state<WorkspaceRepo[]>([]);
  let repositoryCatalog = $state<RepositorySummary[]>([]);
  let workspaceState = $state<ClientWorkspaceState | null>(null);
  let gitClient = $state<GitGuiClient | null>(null);
  let clientWorkspace = $state<ClientWorkspace | null>(null);
  let startError = $state("");
  let bootstrapping = $state(false);
  let operationPending = $state(false);
  let gitAction = $state<{ repositoryId: string; kind: GitActionKind; label: string } | null>(null);
  let commitDrafts = $state<Record<string, WorkingTreeDraftState>>({});
  let amendInfo = $state<GitAmendInfo | null>(null);
  let amendLoading = $state(false);
  let amendRequest = 0;
  let discardDialog = $state<{ repositoryId: string; environmentId: string; files: GitDiscardFile[]; loading: boolean; error: string; client: GitGuiClient } | null>(null);
  const emptyDraft = (): WorkingTreeDraftState => ({ normal: { summary: "", description: "" }, amend: { summary: "", description: "" }, amendMode: false, amendHead: null });
  let queuedGitActions = $state<PendingGitAction[]>([]);
  let scrollToCommit = $state<{ id: number; repositoryId: string; hash: string } | null>(null);
  let largeScreen = $state(false);
  let sidebarWidth = $state(sidebarLimits.default);
  let detailsWidth = $state(detailsLimits.default);
  let activeWorkspaceRequest = 0;
  let largeScreenMediaQuery: MediaQueryList | null = null;
  const applicationRuntime = useWebApplicationRuntime();
  let unsubscribeApplicationRuntime: (() => void) | null = null;
  let appliedRuntimeWorkspace: ClientWorkspace | null = null;
  let connectionError = $state(false);
  let desktopRuntime = $state(false);
  let repositoryPathDialogOpen = $state(false);
  let repositoryPathValue = $state("");
  let repositoryPathError = $state("");
  let createRepositoryParentPath = $state("");
  let createRepositoryName = $state("");
  let createRepositoryInitialBranch = $state("");
  let createRepositoryInitializeLfs = $state(false);
  let createRepositoryProvider = $state<CreateRepositoryProvider>("local");
  let createRepositoryError = $state("");
  let gitNameDialogKind = $state<"branch" | "stash" | null>(null);
  let gitNameDialogValue = $state("");
  let gitNameDialogError = $state("");
  let loadedBranchVisibilityKey = $state<string | null | undefined>(undefined);
  let hiddenGraphRefKeys = $state<Set<string>>(new Set());
  let filteredGraphViews = $state<Map<string, FilteredGraphView>>(new Map());
  let lastGraphRequestKey: string | null = null;
  let lastGraphSource: RepositorySnapshot["graph"] | null = null;
  let graphRequestGeneration = 0;
  const graphScrollPositions = new Map<string, number>();
  let nextScrollCommandId = 0;
  const prefetchedInitialCommits = new Map<string, string>();
  const prefetchedCommitDiffs = new Set<string>();

  const activeRepo = $derived(openRepos.find((repo) => repo.id === activeRepoId) ?? null);
  const snapshot = $derived(activeRepo?.snapshot ?? null);
  const gitActionPending = $derived(gitAction !== null);
  const activeWorkingTreeAction = $derived(
    gitAction?.repositoryId === activeRepoId ? gitAction : null,
  );
  const commitPending = $derived(activeWorkingTreeAction?.kind === "commit" || activeWorkingTreeAction?.kind === "amend");
  const stageActionRunning = $derived(
    activeWorkingTreeAction?.kind === "stage" || activeWorkingTreeAction?.kind === "unstage",
  );
  const queuedStageAction = $derived(
    queuedGitActions.find(
      (action) =>
        action.repositoryId === activeRepoId &&
        (action.kind === "stage" || action.kind === "unstage"),
    ) ?? null,
  );
  const stageQueueWaiting = $derived(gitAction !== null && queuedStageAction !== null && !stageActionRunning);
  const stageQueueLabel = $derived(queuedStageAction?.label ?? null);
  const sidebarStateKey = $derived(
    workspaceState?.environmentId && activeRepoId ? `${workspaceState.environmentId}:${activeRepoId}` : null,
  );
  const activeCommitDraft = $derived(commitDrafts[sidebarStateKey ?? ""] ?? emptyDraft());

  $effect(() => {
    const client = gitClient;
    const repositoryId = activeRepoId;
    const currentSnapshot = snapshot;
    const key = sidebarStateKey;
    const request = ++amendRequest;
    amendInfo = null;
    amendLoading = Boolean(client && repositoryId && currentSnapshot && key);
    if (!client || !repositoryId || !currentSnapshot || !key) return;
    void client.getAmendInfo(repositoryId).then((info) => {
      if (request === amendRequest) amendInfo = info;
    }).catch((error) => {
      if (request === amendRequest) amendInfo = { headOid: null, summary: "", description: "", blockedReason: summarizeGitError(error) };
    }).finally(() => { if (request === amendRequest) amendLoading = false; });
  });

  $effect(() => {
    if (discardDialog && (discardDialog.repositoryId !== activeRepoId || discardDialog.environmentId !== workspaceState?.environmentId)) {
      discardDialog = null;
    }
  });

  const graphVisibilityReady = $derived(
    !activeRepoId || (sidebarStateKey !== null && loadedBranchVisibilityKey === sidebarStateKey),
  );
  const visibleGraphRefs = $derived(
    (snapshot?.refs ?? []).filter(
      (ref) =>
        ref.refType === "tag" ||
        isCurrentBranchRef(ref, snapshot?.status.currentBranch) ||
        !hiddenGraphRefKeys.has(graphRefKey(ref)),
    ),
  );
  const visibleGraphRefKeys = $derived(new Set(visibleGraphRefs.map((ref) => graphRefKey(ref))));
  const graphTargetCommitHashes = $derived([
    ...new Set([
      ...(snapshot?.status.headOid ? [snapshot.status.headOid] : []),
      ...visibleGraphRefs.map((ref) => ref.target),
    ]),
  ]);
  const graphTargetKey = $derived(
    activeRepoId && snapshot
      ? `${activeRepoId}\0${visibleGraphRefs
          .map((ref) => `${graphRefKey(ref)}\0${ref.target}`)
          .join("\0")}\0${graphTargetCommitHashes.join("\0")}`
      : null,
  );
  const filteredGraphView = $derived(
    activeRepoId ? filteredGraphViews.get(activeRepoId) ?? null : null,
  );
  const graphHasHiddenRefs = $derived(
    Boolean(
      snapshot?.refs.some(
        (ref) =>
          ref.refType !== "tag" &&
          !isCurrentBranchRef(ref, snapshot?.status.currentBranch) &&
          hiddenGraphRefKeys.has(graphRefKey(ref)),
      ),
    ),
  );
  const graphSnapshot = $derived(
    !snapshot || !graphVisibilityReady
      ? null
      : filteredGraphView?.key === graphTargetKey || (filteredGraphView && graphHasHiddenRefs)
        ? {
            ...snapshot,
            commits: filteredGraphView.commits,
            graph: filteredGraphView.graph,
            refs: filteredGraphView.refs,
          }
        : graphHasHiddenRefs
          ? null
          : snapshot,
  );
  const selectedGraphItem = $derived(activeRepo?.selectedGraphItem ?? null);
  const selectedFile = $derived(activeRepo?.selectedFile ?? null);
  const selectedFileSource = $derived(activeRepo?.selectedFileSource ?? "workingTree");
  const selectedChangePaths = $derived(activeRepo?.selectedChangePaths ?? []);
  const selectedChangeSource = $derived(activeRepo?.selectedChangeSource ?? "workingTree");
  const selectedCommit = $derived(
    selectedGraphItem?.type === "commit" ? selectedGraphItem.commit : null,
  );
  const changesSelected = $derived(selectedGraphItem?.type === "changes");
  const repoTabs = $derived<RepoTab[]>(
    openRepos.map((repo) => ({
      id: repo.id,
      title: repo.title,
      root: repo.root,
      isWorktree: repo.isWorktree,
      branch: repo.snapshot ? repo.snapshot.status.currentBranch ?? "Detached HEAD" : "",
      error: repo.error ?? "",
    })),
  );
  const loading = $derived(
    bootstrapping ||
      operationPending ||
      workspaceState?.restoring === true ||
      workspaceState?.opening === true,
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
  const largeScreenPanes = $derived<ResizablePane[]>(
    selectedFile && (selectedCommit || changesSelected)
      ? [
          {
            id: "diff",
            minWidth: 420,
            flexible: true,
          },
          {
            id: "graph",
            minWidth: 0,
            maxWidth: 0,
            width: 0,
          },
          detailsPane,
        ]
      : graphPanes,
  );

  $effect(() => {
    const key = sidebarStateKey;
    if (key === loadedBranchVisibilityKey) {
      return;
    }

    hiddenGraphRefKeys = key ? readHiddenGraphRefKeys(key) : new Set();
    loadedBranchVisibilityKey = key;
  });

  $effect(() => {
    if (scrollToCommit?.repositoryId && scrollToCommit.repositoryId !== activeRepoId) {
      scrollToCommit = null;
    }
  });

  $effect(() => {
    const client = gitClient;
    const repositoryId = activeRepoId;
    const key = graphTargetKey;
    const targetCommits = graphTargetCommitHashes;

    if (!graphVisibilityReady || !client || !repositoryId || !snapshot || !key) {
      lastGraphRequestKey = null;
      return;
    }

    if (filteredGraphView?.key === key && filteredGraphView.sourceGraph === snapshot.graph) {
      lastGraphRequestKey = key;
      return;
    }

    if (!graphHasHiddenRefs) {
      lastGraphRequestKey = key;
      return;
    }

    if (key === lastGraphRequestKey && lastGraphSource === snapshot.graph) {
      return;
    }

    lastGraphRequestKey = key;
    lastGraphSource = snapshot.graph;
    const sourceGraph = snapshot.graph;
    const generation = ++graphRequestGeneration;
    const targetRefs = [...visibleGraphRefs];

    void client
      .getRepositoryGraph({ repositoryId, targetCommits })
      .then((result) => {
        if (generation !== graphRequestGeneration || key !== lastGraphRequestKey) {
          return;
        }

        const nextViews = new Map(filteredGraphViews);
        nextViews.set(repositoryId, {
          repositoryId,
          key,
          refs: targetRefs,
          commits: result.commits,
          graph: result.graph,
          sourceGraph,
        });
        filteredGraphViews = nextViews;
      })
      .catch(() => undefined);
  });

  onMount(() => {
    desktopRuntime = applicationRuntime.isDesktop;
    restoreLayout();
    largeScreenMediaQuery = window.matchMedia("(min-width: 1024px)");
    largeScreen = largeScreenMediaQuery.matches;
    largeScreenMediaQuery.addEventListener("change", updateLargeScreen);
    unsubscribeApplicationRuntime = applicationRuntime.subscribe(applyApplicationRuntimeState);
  });

  onDestroy(() => {
    largeScreenMediaQuery?.removeEventListener("change", updateLargeScreen);
    unsubscribeApplicationRuntime?.();
    unsubscribeApplicationRuntime = null;
  });

  function updateLargeScreen(event: MediaQueryListEvent) {
    largeScreen = event.matches;
  }

  function applyApplicationRuntimeState(state: WebApplicationRuntimeState) {
    // Registrations survive disconnects. Their removal is the signal to
    // release environment-owned drafts, matching the runtime's cache lifetime.
    const registeredEnvironments = new Set(state.registry.entries.map((entry) => entry.registration.environmentId));
    for (const key of Object.keys(commitDrafts)) {
      if (!registeredEnvironments.has(key.slice(0, key.indexOf(":")))) delete commitDrafts[key];
    }
    bootstrapping = state.loading;
    connectionError = state.connection?.phase === "blocked"
      || state.connection?.phase === "offline";
    startError = state.error;
    if (connectionError) activeView = "start";

    if (!state.client || !state.workspace || !state.workspaceState) return;
    gitClient = state.client;
    clientWorkspace = state.workspace;
    applyWorkspaceState(state.workspaceState);
    if (appliedRuntimeWorkspace !== state.workspace) {
      appliedRuntimeWorkspace = state.workspace;
      void refreshRepositoryCatalog(state.client).then(async () => {
        if (!desktopRuntime && !state.workspace!.state.openRepositoryIds.length && repositoryCatalog.length === 1) {
          await state.workspace!.openKnownRepository(repositoryCatalog[0].id);
        }
        if (activeView !== "settings") activeView = activeRepoId ? "repo" : "start";
      }).catch((caught) => {
        startError = formatError(caught);
        connectionError = true;
      });
    }
  }

  async function retryLocalConnection() {
    if (bootstrapping) return;
    activeView = "start";
    connectionError = true;
    startError = desktopRuntime ? "Restarting the local GitGui server…" : "Retrying the GitGui connection…";
    try {
      await applicationRuntime.retrySelected(desktopRuntime);
    } catch (caught) {
      startError = formatError(caught);
    }
  }
  function isConnectionError(caught: unknown) {
    if (typeof caught !== "object" || caught === null) return false;
    if ("kind" in caught) return true;
    if (!("code" in caught)) return false;
    return typeof caught.code === "string" && [
      "connection_failed",
      "not_connected",
      "websocket_unavailable",
      "incompatible_protocol",
      "unauthorized",
      "forbidden",
      "disconnected",
    ].includes(caught.code);
  }

  async function refreshRepositoryCatalog(client: GitGuiClient = gitClient!) {
    if (!client) {
      return;
    }

    const repositories = await client.listRepositories();
    repositoryCatalog = mergeRepositoryCatalog(repositories, workspaceState);
    if (workspaceState) {
      applyWorkspaceState(workspaceState);
    }
  }

  async function chooseRepository() {
    startError = "";

    if (!desktopRuntime) {
      repositoryPathValue = "";
      repositoryPathError = "";
      repositoryPathDialogOpen = true;
      return;
    }

    try {
      const selectedPath = await chooseDesktopRepository();

      if (typeof selectedPath === "string") {
        await runWorkspaceCommand(() => requireWorkspace().openRepositoryPath(selectedPath));
      }
    } catch (caught) {
      startError = formatError(caught);
    }
  }

  async function chooseCreateRepository() {
    createRepositoryProvider = "local";
    createRepositoryParentPath = await resolveProjectsLocation();
    createRepositoryName = "";
    createRepositoryInitialBranch = "";
    createRepositoryInitializeLfs = false;
    createRepositoryError = "";
    activeView = "create";
  }

  function changeCreateRepositoryProvider(provider: CreateRepositoryProvider) {
    createRepositoryProvider = provider;
    createRepositoryError = "";
  }

  async function browseCreateRepositoryLocation() {
    if (!desktopRuntime) {
      return;
    }

    try {
      const selectedPath = await chooseDesktopCreateLocation();
      if (typeof selectedPath === "string") {
        createRepositoryParentPath = selectedPath;
        createRepositoryError = "";
      }
    } catch (caught) {
      createRepositoryError = formatError(caught);
    }
  }

  function closeCreateRepositoryView() {
    if (!operationPending) {
      createRepositoryError = "";
      activeView = "start";
    }
  }

  async function submitCreateRepository() {
    if (createRepositoryProvider !== "local") {
      createRepositoryError = `${createRepositoryProvider === "github" ? "Github" : "Bitbucket"} repository creation is not available yet.`;
      return;
    }

    const name = createRepositoryName.trim();
    if (!name) {
      createRepositoryError = "Enter a repository name to continue.";
      return;
    }
    if (name === "." || name === ".." || /[\\/:]/.test(name)) {
      createRepositoryError = "Use a single folder name without slashes or a drive prefix.";
      return;
    }

    createRepositoryError = "";
    const created = await runWorkspaceCommand(() =>
      requireWorkspace().createRepository(createRepositoryParentPath.trim(), name, {
        ...(createRepositoryInitialBranch.trim()
          ? { initialBranch: createRepositoryInitialBranch.trim() }
          : {}),
        initializeLfs: createRepositoryInitializeLfs,
      }),
    );
    if (created) {
      createRepositoryParentPath = "";
      createRepositoryName = "";
      createRepositoryInitialBranch = "";
      createRepositoryInitializeLfs = false;
    } else {
      createRepositoryError = startError || "The repository could not be created.";
    }
  }

  function closeRepositoryPathDialog() {
    if (!operationPending) {
      repositoryPathDialogOpen = false;
      repositoryPathError = "";
    }
  }

  async function submitRepositoryPath() {
    const path = repositoryPathValue.trim();
    if (!path) {
      repositoryPathError = "Enter a repository path on the connected host.";
      return;
    }

    repositoryPathError = "";
    const opened = await runWorkspaceCommand(() => requireWorkspace().openRepositoryPath(path));
    if (opened) {
      repositoryPathDialogOpen = false;
      repositoryPathValue = "";
    } else {
      repositoryPathError = startError || "The repository could not be opened.";
    }
  }

  async function chooseDesktopRepository() {
    return applicationRuntime.pickFolder();
  }

  async function chooseDesktopCreateLocation() {
    return applicationRuntime.pickFolder();
  }

  async function openRepository(repositoryId: string) {
    await runWorkspaceCommand(() => requireWorkspace().openKnownRepository(repositoryId));
  }

  async function removeRepository(repositoryId: string) {
    const draftKey = workspaceState?.environmentId ? `${workspaceState.environmentId}:${repositoryId}` : null;
    const removed = await runWorkspaceCommand(() => requireWorkspace().removeRepository(repositoryId));
    if (removed) {
      if (draftKey) delete commitDrafts[draftKey];
      repositoryCatalog = repositoryCatalog.filter((repository) => repository.id !== repositoryId);
      activeView = "start";
    }
  }

  async function selectRepo(repoId: string) {
    await runWorkspaceCommand(() => requireWorkspace().selectRepository(repoId));
  }

  async function closeRepo(repoId: string) {
    const wasVisibleActive = activeView === "repo" && activeRepoId === repoId;
    await runWorkspaceCommand(() => requireWorkspace().closeRepository(repoId));

    if (wasVisibleActive) {
      activeView = activeRepoId ? "repo" : "start";
    }
  }

  async function runWorkspaceCommand(action: () => Promise<unknown>): Promise<boolean> {
    const request = ++activeWorkspaceRequest;
    operationPending = true;
    startError = "";

    try {
      await action();
      if (request === activeWorkspaceRequest) {
        activeView = activeRepoId ? "repo" : activeView;
      }
      return true;
    } catch (caught) {
      if (request === activeWorkspaceRequest) {
        startError = formatError(caught);
        if (isConnectionError(caught)) {
          connectionError = true;
          activeView = "start";
        }
      }
      return false;
    } finally {
      if (request === activeWorkspaceRequest) {
        operationPending = false;
      }
    }
  }

  function applyWorkspaceState(state: ClientWorkspaceState) {
    workspaceState = state;
    const previousRepos = openRepos;
    repositoryCatalog = mergeRepositoryCatalog(repositoryCatalog, state);
    activeRepoId = state.activeRepositoryId;
    openRepos = state.openRepositoryIds.flatMap((repositoryId) => {
      const repositoryState = state.repositories[repositoryId];

      if (!repositoryState) {
        return [];
      }

      const snapshot = repositoryState.snapshot;
      const previousRepo = previousRepos.find((candidate) => candidate.id === repositoryId);
      const selectedGraphItem = snapshot
        ? reconcileSelection(previousRepo?.selectedGraphItem ?? null, snapshot)
        : previousRepo?.selectedGraphItem ?? null;
      const selectedFile = snapshot
        ? selectedGraphItem?.type === "changes"
          ? reconcileWorkingTreeFile(previousRepo?.selectedFile ?? null, previousRepo?.selectedFileSource ?? "workingTree", snapshot)
          : selectedGraphItem?.type === "commit" && previousRepo?.selectedGraphItem?.type === "commit"
              && selectedGraphItem.commit.hash === previousRepo.selectedGraphItem.commit.hash
            ? previousRepo.selectedFile
            : null
        : previousRepo?.selectedFile ?? null;

      return [{
        id: repositoryState.repository.id,
        title: repositoryTitle(repositoryState.repository),
        root: repositoryState.repository.root,
        isWorktree: repositoryState.repository.isWorktree === true,
        snapshot,
        error: repositoryState.error?.message ?? null,
        loading: repositoryState.loading || repositoryState.refreshing,
        selectedGraphItem,
        selectedFile,
        selectedFileSource:
          selectedGraphItem?.type === "changes" && selectedFile
            ? previousRepo?.selectedFileSource ?? "workingTree"
            : null,
        selectedChangePaths: previousRepo?.selectedChangePaths ?? [],
        selectedChangeSource:
          selectedGraphItem?.type === "changes"
            ? previousRepo?.selectedChangeSource ?? "workingTree"
            : null,
      }];
    });
    prunePrefetchState(openRepos);
    prefetchInitialCommitFiles(openRepos);

    if (state.error) {
      startError = state.error.message;
    }
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
      if (!repo.snapshot || !clientWorkspace) {
        continue;
      }

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
      void clientWorkspace.prefetchCommitFiles(repo.id, commitHashes).catch(() => {
        prefetchedInitialCommits.delete(repo.id);
      });
    }
  }

  async function refreshOpenRepositories() {
    if (bootstrapping || connectionError || !openRepos.length || !clientWorkspace || workspaceState?.restoring) {
      return;
    }

    try {
      await clientWorkspace.refreshAllRepositories();
    } catch {
      // Refresh errors are returned as per-repo tab errors when possible.
    }
  }

  async function refreshRepository(repoId: string) {
    if (connectionError || !openRepos.some((repo) => repo.id === repoId) || !clientWorkspace) {
      return;
    }

    try {
      await clientWorkspace.refreshRepository(repoId);
    } catch {
      // Refresh errors are returned as per-repo tab errors when possible.
    }
  }

  function requireWorkspace() {
    if (!clientWorkspace) {
      throw new Error("The local GitGui server is not connected.");
    }

    return clientWorkspace;
  }

  function mergeRepositoryCatalog(
    repositories: RepositorySummary[],
    state: ClientWorkspaceState | null,
  ): RepositorySummary[] {
    const merged = new Map(
      repositories
        .filter((repository) => repository.isWorktree !== true)
        .map((repository) => [repository.id, repository]),
    );

    for (const repositoryState of state ? Object.values(state.repositories) : []) {
      if (repositoryState.repository.isWorktree !== true) {
        merged.set(repositoryState.repository.id, repositoryState.repository);
      }
    }

    return [...merged.values()];
  }

  function repositoryTitle(repository: RepositorySummary) {
    if (repository.name) {
      return repository.name;
    }

    const normalizedRoot = repository.root.replace(/[\\/]+$/, "");
    const separator = Math.max(normalizedRoot.lastIndexOf("/"), normalizedRoot.lastIndexOf("\\"));
    return normalizedRoot.slice(separator + 1) || repository.root;
  }

  const homeRepositories = $derived<RepositoryListItem[]>(
    repositoryCatalog
      .filter((repository) => repository.isWorktree !== true)
      .map((repository) => ({
        repositoryId: repository.id,
        root: repository.root,
        title: repositoryTitle(repository),
      })),
  );

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

  function formatError(caught: unknown) {
    if (typeof caught === "object" && caught && "message" in caught) {
      const reason = errorReason(caught);
      return reason ? `${caught.message} ${reason}` : `${caught.message}`;
    }

    return String(caught);
  }

  function errorReason(caught: object) {
    const directStderr =
      "stderr" in caught && typeof caught.stderr === "string" ? caught.stderr : "";
    if (directStderr.trim()) {
      return directStderr.trim();
    }

    if (
      !("details" in caught) ||
      typeof caught.details !== "object" ||
      caught.details === null ||
      Array.isArray(caught.details)
    ) {
      return "";
    }

    const details = caught.details;
    if ("stderr" in details && typeof details.stderr === "string" && details.stderr.trim()) {
      return details.stderr.trim();
    }

    if ("status" in details && typeof details.status === "number") {
      return `Git exited with status ${details.status}.`;
    }

    return "";
  }

  function summarizeGitError(caught: unknown) {
    const reason =
      typeof caught === "object" && caught !== null ? errorReason(caught).toLowerCase() : String(caught).toLowerCase();
    if (reason.includes("local changes") && reason.includes("overwritten")) {
      return "Local changes would be overwritten.";
    }
    if (reason.includes("conflict")) {
      return "Conflicts need to be resolved.";
    }
    if (reason.includes("did not match any") || reason.includes("pathspec")) {
      return "That branch was not found.";
    }
    if (reason.includes("already exists")) {
      return "That branch already exists.";
    }
    if (reason.includes("not a git repository")) {
      return "This is not a Git repository.";
    }
    return formatError(caught) || "Git could not complete the operation.";
  }

  function hasUnmergedFiles(repositoryId: string, state: ClientWorkspaceState) {
    const snapshot = state.repositories[repositoryId]?.snapshot;
    return snapshot?.status.changedFiles.some((file) =>
      file.indexStatus.includes("U") || file.worktreeStatus.includes("U"),
    ) ?? false;
  }

  function showStartView() {
    activeView = "start";
  }

  function showSettingsView() {
    activeView = "settings";
  }

  function selectCommit(commit: CommitInfo) {
    if (snapshot && activeRepoId) {
      void prefetchCommitDiffs(activeRepoId, commit);
    }

    updateActiveRepo((repo) => ({
      ...repo,
      selectedGraphItem: { type: "commit", commit },
      selectedFile: null,
      selectedFileSource: null,
      selectedChangePaths: [],
      selectedChangeSource: null,
    }));
  }

  function selectRef(ref: CommitRef) {
    const commit = snapshot?.commits.find((candidate) => candidate.hash === ref.target);
    if (commit && activeRepoId) {
      scrollToCommit = {
        id: ++nextScrollCommandId,
        repositoryId: activeRepoId,
        hash: commit.hash,
      };
      selectCommit(commit);
    }
  }

  function switchBranch(branchName: string) {
    if (!activeRepoId || !gitClient || gitActionPending) {
      return;
    }

    requestGitAction({
      kind: "switchBranch",
      label: `Switching to ${branchName}`,
      successMessage: `Switched to ${branchName}`,
      action: (repositoryId) =>
        gitClient!.switchBranch({
          repositoryId,
          name: branchName,
          merge: readBranchSwitchMergePreference(),
        }),
    });
  }

  function switchWorktree(path: string) {
    const repositoryId = activeRepoId;
    if (!path.trim() || !repositoryId || !clientWorkspace || operationPending) {
      return;
    }

    void runWorkspaceCommand(() => requireWorkspace().switchRepositoryPath(path, repositoryId));
  }

  function finishScrollToCommit(commandId: number) {
    if (scrollToCommit?.id === commandId) {
      scrollToCommit = null;
    }
  }

  function toggleGraphRefs(refs: CommitRef[], visible: boolean) {
    const nextHidden = new Set(hiddenGraphRefKeys);
    const currentBranch = snapshot?.status.currentBranch;

    for (const ref of refs) {
      if (isCurrentBranchRef(ref, currentBranch)) {
        nextHidden.delete(graphRefKey(ref));
        continue;
      }

      if (visible) {
        nextHidden.delete(graphRefKey(ref));
      } else {
        nextHidden.add(graphRefKey(ref));
      }
    }

    hiddenGraphRefKeys = nextHidden;
    persistHiddenGraphRefKeys(sidebarStateKey, nextHidden);
  }

  function branchVisibilityStorageKey(key: string) {
    return `${branchGraphVisibilityStoragePrefix}:${encodeURIComponent(key)}`;
  }

  function readHiddenGraphRefKeys(key: string) {
    try {
      const stored = localStorage.getItem(branchVisibilityStorageKey(key));
      if (!stored) {
        return new Set<string>();
      }

      const parsed: unknown = JSON.parse(stored);
      if (!Array.isArray(parsed)) {
        return new Set<string>();
      }

      return new Set(parsed.filter((value): value is string => typeof value === "string"));
    } catch {
      return new Set<string>();
    }
  }

  function persistHiddenGraphRefKeys(key: string | null, hiddenKeys: ReadonlySet<string>) {
    if (!key) {
      return;
    }

    try {
      localStorage.setItem(branchVisibilityStorageKey(key), JSON.stringify([...hiddenKeys]));
    } catch {
      // Graph visibility is a best-effort client preference.
    }
  }

  function rememberGraphScrollTop(repositoryId: string, scrollTop: number) {
    graphScrollPositions.set(repositoryId, scrollTop);
  }

  function graphScrollTopFor(repositoryId: string) {
    return graphScrollPositions.get(repositoryId) ?? 0;
  }

  async function prefetchCommitDiffs(repositoryId: string, commit: CommitInfo) {
    const parentHash = commit.parents[0] ?? null;
    const signature = `${repositoryId}:${commit.hash}:${parentHash ?? ""}`;

    if (prefetchedCommitDiffs.has(signature) || !gitClient || !clientWorkspace) {
      return;
    }

    prefetchedCommitDiffs.add(signature);
    try {
      const result = await gitClient.getCommitFiles(repositoryId, commit.hash);
      await clientWorkspace.prefetchCommitDiffs({
        repositoryId,
        targets: result.files.map((file) => ({
          commitHash: commit.hash,
          ...(parentHash ? { parentHash } : {}),
          filePath: file.path,
        })),
      });
    } catch {
      prefetchedCommitDiffs.delete(signature);
    }
  }

  function selectChanges() {
    updateActiveRepo((repo) => ({
      ...repo,
      selectedGraphItem: { type: "changes" },
      selectedFile: null,
      selectedFileSource: null,
      selectedChangePaths: [],
      selectedChangeSource: null,
    }));
  }

  function selectFile(file: CommitFile, source: WorkingTreeDiffSource = "workingTree") {
    updateActiveRepo((repo) => ({
      ...repo,
      selectedFile: file,
      selectedFileSource: source,
      selectedChangeSource:
        repo.selectedGraphItem?.type === "changes" ? source : repo.selectedChangeSource,
    }));
  }

  function selectChangePaths(paths: string[], source: WorkingTreeDiffSource) {
    updateActiveRepo((repo) => ({
      ...repo,
      selectedChangePaths: paths,
      selectedChangeSource: source,
    }));
  }

  function requestGitAction(request: GitActionRequest, queueWhenBusy = false) {
    const repositoryId = activeRepoId;
    if (!repositoryId || !gitClient || !clientWorkspace) {
      return;
    }

    if (gitAction !== null) {
      if (queueWhenBusy) {
        queuedGitActions = [...queuedGitActions, { ...request, repositoryId }];
      }
      return;
    }

    void runGitAction({ ...request, repositoryId });
  }

  async function runGitAction(request: PendingGitAction) {
    const workspace = clientWorkspace;
    if (!workspace) {
      return;
    }

    gitAction = {
      repositoryId: request.repositoryId,
      kind: request.kind,
      label: request.label,
    };

    let applied = false;
    try {
      await request.action(request.repositoryId);
      applied = true;
      request.onApplied?.();
      const refreshedState = await refreshAfterMutation(workspace, request.repositoryId);
      if (request.kind === "switchBranch" && hasUnmergedFiles(request.repositoryId, refreshedState)) {
        toast.warning("Switched with conflicts", { description: "Resolve the highlighted conflicts." });
      } else if (request.notifySuccess !== false && request.successMessage) {
        toast.success(request.successMessage);
      }
    } catch (caught) {
      const details = typeof caught === "object" && caught && "details" in caught ? caught.details : null;
      const serverApplied = typeof details === "object" && details && "mutationSucceeded" in details && details.mutationSucceeded === true;
      if (applied || serverApplied) {
        if (!applied) request.onApplied?.();
        toast.warning("Changes applied; refresh failed", {
          description: summarizeGitError(caught),
          action: { label: "Retry refresh", onClick: () => { void refreshAfterMutation(workspace, request.repositoryId).catch((error) => toast.error("Refresh failed", { description: summarizeGitError(error) })); } },
        });
      } else {
        await workspace.refreshRepository(request.repositoryId).catch(() => undefined);
        toast.error(`${request.label} failed`, { description: summarizeGitError(caught) });
      }
    } finally {
      gitAction = null;
      const nextAction = queuedGitActions[0];
      queuedGitActions = queuedGitActions.slice(1);
      if (nextAction) {
        void runGitAction(nextAction);
      }
    }
  }

  async function refreshAfterMutation(workspace: ClientWorkspace, repositoryId: string) {
    const state = await workspace.refreshRepository(repositoryId);
    const repository = state.repositories[repositoryId];
    if (repository?.error) throw new Error(repository.error.message);
    return state;
  }

  function changeCommitDraft(draft: WorkingTreeDraftState) {
    if (sidebarStateKey) commitDrafts[sidebarStateKey] = draft;
  }

  function toggleAmend(enabled: boolean) {
    const key = sidebarStateKey;
    if (!key) return;
    const draft = commitDrafts[key] ?? emptyDraft();
    if (!enabled) { commitDrafts[key] = { ...draft, amendMode: false }; return; }
    if (!amendInfo?.headOid || amendInfo.blockedReason || amendLoading) return;
    commitDrafts[key] = { ...draft, amendMode: true, amendHead: amendInfo.headOid,
      amend: draft.amendHead === amendInfo.headOid ? draft.amend : { summary: amendInfo.summary, description: amendInfo.description } };
  }

  async function openDiscard(paths: string[]) {
    const client = gitClient;
    const repositoryId = activeRepoId;
    const environmentId = workspaceState?.environmentId;
    if (!client || !repositoryId || !environmentId || gitActionPending || !paths.length) return;
    const dialog = { repositoryId, environmentId, client, files: [] as GitDiscardFile[], loading: true, error: "" };
    discardDialog = dialog;
    try {
      const files = await client.previewDiscard(repositoryId, paths);
      if (discardDialog?.repositoryId === repositoryId && discardDialog.environmentId === environmentId) {
        discardDialog = { ...dialog, files, loading: false };
      }
    } catch (caught) {
      if (discardDialog?.repositoryId === repositoryId && discardDialog.environmentId === environmentId) {
        discardDialog = { ...dialog, loading: false, error: summarizeGitError(caught) };
      }
    }
  }

  function confirmDiscard(files: GitDiscardFile[], deleteUntracked: boolean) {
    const dialog = discardDialog;
    if (!dialog || gitActionPending || !files.length) return;
    discardDialog = { ...dialog, loading: true, error: "" };
    requestGitAction({ kind: "discard", label: "Discarding", notifySuccess: false,
      action: async (repositoryId) => {
        try {
          const outcome = await dialog.client.discard({ repositoryId, files, deleteUntracked });
          discardDialog = null;
          if (outcome.error) toast.error("Discard stopped", { description: `${outcome.error}\nChanged: ${outcome.completedPaths.join(", ") || "none"}\nRemaining: ${outcome.remainingPaths.join(", ")}` });
          else toast.success(`Discarded changes in ${outcome.completedPaths.length} files`);
        } catch (caught) {
          if (discardDialog?.repositoryId === repositoryId && discardDialog.environmentId === dialog.environmentId) discardDialog = { ...dialog, loading: false, error: `${summarizeGitError(caught)} Close this dialog and review the updated changes.` };
          throw caught;
        }
      },
    });
  }

  function applySelectedHunks(params: GitApplyHunksParams) {
    const client = gitClient;
    if (!client || gitActionPending) return;
    requestGitAction({ kind: params.staged ? "unstage" : "stage", label: params.staged ? "Unstaging hunks" : "Staging hunks", notifySuccess: false,
      action: () => client.applyHunks(params),
    });
  }

  function stageFile(file: ChangedFile) {
    requestGitAction(
      {
        kind: "stage",
        label: "Staging",
        notifySuccess: false,
        action: (repositoryId) => gitClient!.stage(repositoryId, [file.path]),
      },
      true,
    );
  }

  function stagePaths(paths: string[]) {
    if (!paths.length) {
      return;
    }

    requestGitAction(
      {
        kind: "stage",
        label: "Staging",
        notifySuccess: false,
        action: (repositoryId) => gitClient!.stage(repositoryId, paths),
      },
      true,
    );
  }

  function unstageFile(file: ChangedFile) {
    requestGitAction(
      {
        kind: "unstage",
        label: "Unstaging",
        notifySuccess: false,
        action: (repositoryId) => gitClient!.unstage(repositoryId, [file.path]),
      },
      true,
    );
  }

  function unstagePaths(paths: string[]) {
    if (!paths.length) {
      return;
    }

    requestGitAction(
      {
        kind: "unstage",
        label: "Unstaging",
        notifySuccess: false,
        action: (repositoryId) => gitClient!.unstage(repositoryId, paths),
      },
      true,
    );
  }

  function stageAll() {
    requestGitAction(
      {
        kind: "stage",
        label: "Staging",
        notifySuccess: false,
        action: (repositoryId) => gitClient!.stage(repositoryId),
      },
      true,
    );
  }

  function unstageAll() {
    requestGitAction(
      {
        kind: "unstage",
        label: "Unstaging",
        notifySuccess: false,
        action: (repositoryId) => gitClient!.unstage(repositoryId),
      },
      true,
    );
  }

  function commitChanges(draft: CommitMessageDraft) {
    const client = gitClient;
    const key = sidebarStateKey;
    if (!client || !key) return;
    requestGitAction({
      kind: draft.amend ? "amend" : "commit",
      label: draft.amend ? "Amending" : "Committing",
      successMessage: draft.amend ? "Last commit amended" : "Changes committed",
      action: (repositoryId) => draft.amend
        ? client.amend({ repositoryId, expectedHead: draft.expectedHead ?? "", summary: draft.summary, ...(draft.description ? { description: draft.description } : {}) })
        : client.commit({ repositoryId, summary: draft.summary, ...(draft.description ? { description: draft.description } : {}) }),
      onApplied: () => {
        const state = commitDrafts[key] ?? emptyDraft();
        commitDrafts[key] = draft.amend
          ? { ...state, amendMode: false, amendHead: null, amend: { summary: "", description: "" } }
          : { ...state, normal: { summary: "", description: "" } };
      },
    });
  }

  function fetchRepository() {
    requestGitAction({
      kind: "fetch",
      label: "Fetching",
      successMessage: "Fetched from remote",
      action: (repositoryId) => gitClient!.fetch(repositoryId),
    });
  }

  function pullRepository() {
    requestGitAction({
      kind: "pull",
      label: "Pulling",
      successMessage: "Pulled from remote",
      action: (repositoryId) => gitClient!.pull(repositoryId),
    });
  }

  function pushRepository() {
    requestGitAction({
      kind: "push",
      label: "Pushing",
      successMessage: "Pushed to remote",
      action: (repositoryId) => gitClient!.push(repositoryId),
    });
  }

  function openBranchDialog() {
    if (!activeRepoId || !gitClient || gitActionPending) {
      return;
    }

    gitNameDialogValue = "";
    gitNameDialogError = "";
    gitNameDialogKind = "branch";
  }

  function openStashDialog() {
    if (!activeRepoId || !gitClient || gitActionPending) {
      return;
    }

    gitNameDialogValue = "";
    gitNameDialogError = "";
    gitNameDialogKind = "stash";
  }

  function closeGitNameDialog() {
    if (!gitActionPending) {
      gitNameDialogKind = null;
      gitNameDialogValue = "";
      gitNameDialogError = "";
    }
  }

  function submitGitNameDialog() {
    const name = gitNameDialogValue.trim();
    if (!gitNameDialogKind) {
      return;
    }

    if (gitNameDialogKind === "branch") {
      if (!name) {
        gitNameDialogError = "Enter a branch name to continue.";
        return;
      }

      closeGitNameDialog();
      requestGitAction({
        kind: "createBranch",
        label: "Creating branch",
        successMessage: `Created and switched to ${name}`,
        action: (repositoryId) => gitClient!.createBranch({ repositoryId, name, checkout: true }),
      });
      return;
    }

    closeGitNameDialog();
    requestGitAction({
      kind: "stash",
      label: "Stashing",
      successMessage: "Changes stashed",
      action: (repositoryId) => gitClient!.stashPush({
        repositoryId,
        message: name || undefined,
        includeUntracked: true,
      }),
    });
  }

  function popStash() {
    requestGitAction({
      kind: "stashPop",
      label: "Popping stash",
      successMessage: "Stash applied",
      action: (repositoryId) => gitClient!.stashPop(repositoryId),
    });
  }

  function closeDiff() {
    updateActiveRepo((repo) => ({
      ...repo,
      selectedFile: null,
      selectedFileSource: null,
      selectedChangePaths: [],
      selectedChangeSource: null,
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

<main class="grid h-screen min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] bg-[var(--app-theme-canvas)] text-[var(--app-theme-text)]">
  <TopMenu
    activeView={activeView}
    {activeRepoId}
    tabs={repoTabs}
    onShowStart={showStartView}
    onShowSettings={showSettingsView}
    onSelectRepo={selectRepo}
    onCloseRepo={closeRepo}
  />

  <section class="min-h-0 overflow-hidden">
    {#if activeView === "settings"}
      <SettingsView />
    {:else if activeView === "create"}
      <CreateRepositoryView
        provider={createRepositoryProvider}
        parentPath={createRepositoryParentPath}
        name={createRepositoryName}
        initialBranch={createRepositoryInitialBranch}
        initializeLfs={createRepositoryInitializeLfs}
        error={createRepositoryError}
        loading={operationPending}
        canBrowse={desktopRuntime}
        onProviderChange={changeCreateRepositoryProvider}
        onParentPathChange={(value) => {
          createRepositoryParentPath = value;
          createRepositoryError = "";
        }}
        onNameChange={(value) => {
          createRepositoryName = value;
          createRepositoryError = "";
        }}
        onInitialBranchChange={(value) => {
          createRepositoryInitialBranch = value;
          createRepositoryError = "";
        }}
        onInitializeLfsChange={(value) => {
          createRepositoryInitializeLfs = value;
          createRepositoryError = "";
        }}
        onBrowse={browseCreateRepositoryLocation}
        onSubmit={submitCreateRepository}
        onCancel={closeCreateRepositoryView}
      />
    {:else if activeView === "start" || !activeRepo}
      <StartView
        repositories={homeRepositories}
        {loading}
        error={startError}
        {connectionError}
        onChooseRepository={chooseRepository}
        onCreateRepository={chooseCreateRepository}
        onRemoveRepository={removeRepository}
        canCreateRepository={desktopRuntime}
        onOpenRepository={openRepository}
        onRetryConnection={retryLocalConnection}
      />
    {:else}
      {#if !largeScreen}
      <div class="grid h-full min-h-0 grid-cols-1 overflow-hidden">
        {#if snapshot && selectedFile && (selectedCommit || changesSelected)}
          <Sidebar
            {snapshot}
            {selectedCommit}
            stateKey={sidebarStateKey}
            visibleRefKeys={visibleGraphRefKeys}
            onSelectRef={selectRef}
            onSwitchBranch={switchBranch}
            onSwitchWorktree={switchWorktree}
            onToggleRefs={toggleGraphRefs}
          />
          <div class="h-full min-h-0">
            <CommitFileDiffViewer
              client={gitClient!}
              repositoryId={activeRepoId!}
              {snapshot}
              diffSource={changesSelected ? selectedFileSource : "commit"}
              selectedCommit={selectedCommit}
              {selectedFile}
              onClose={closeDiff}
              onApplyHunks={applySelectedHunks}
              pending={gitActionPending}
            />
          </div>
        {:else}
          <Sidebar
            {snapshot}
            {selectedCommit}
            stateKey={sidebarStateKey}
            visibleRefKeys={visibleGraphRefKeys}
            onSelectRef={selectRef}
            onSwitchWorktree={switchWorktree}
            onToggleRefs={toggleGraphRefs}
          />
          <div class="flex min-h-0 flex-col overflow-hidden">
            <HistoryToolbar
              onFetch={fetchRepository}
              onPull={pullRepository}
              onPush={pushRepository}
              onBranch={openBranchDialog}
              onStash={openStashDialog}
              onPop={popStash}
              pending={gitActionPending}
              pendingKind={gitAction?.kind ?? null}
            />
            <div class="min-h-0 flex-1">
              {#key activeRepoId}
                <GitGraph
                  snapshot={graphSnapshot}
                  repositoryId={activeRepoId}
                  getRestoredScrollTop={graphScrollTopFor}
                  {selectedCommit}
                  {changesSelected}
                  {scrollToCommit}
                  onScrollTopChange={rememberGraphScrollTop}
                  onScrollCommandHandled={finishScrollToCommit}
                  onSelectChanges={selectChanges}
                  onSelectCommit={selectCommit}
                />
              {/key}
            </div>
          </div>
        {/if}
        {#if snapshot && changesSelected}
          <WorkingTreePanel
            {snapshot}
            selectedPaths={selectedChangePaths}
            selectedPathsSource={selectedChangeSource}
            onSelectionPathsChange={selectChangePaths}
            onSelectFile={selectFile}
            onStageFile={stageFile}
            onStagePaths={stagePaths}
            onUnstageFile={unstageFile}
            onUnstagePaths={unstagePaths}
            onStageAll={stageAll}
            onUnstageAll={unstageAll}
            onCommit={commitChanges}
            draft={activeCommitDraft}
            {amendInfo}
            {amendLoading}
            onDraftChange={changeCommitDraft}
            onAmendToggle={toggleAmend}
            onDiscardPaths={openDiscard}
            disabled={gitActionPending}
            pending={gitActionPending}
            commitPending={commitPending}
            stageActionRunning={stageActionRunning}
            stageQueueWaiting={stageQueueWaiting}
            stageQueueLabel={stageQueueLabel}
          />
        {:else if snapshot && selectedCommit}
          <CommitDetailsPanel
            client={gitClient!}
            repositoryId={activeRepoId!}
            {snapshot}
            {selectedCommit}
            {selectedFile}
            onSelectFile={selectFile}
          />
        {:else if snapshot}
          <RepositoryDetailsPanel {snapshot} />
        {:else}
          <EmptyDetailsPanel />
        {/if}
      </div>
      {:else}
      <div class="h-full min-h-0">
        <ResizablePaneGroup panes={largeScreenPanes} onResize={resizePane}>
          {#snippet pane0()}
            {#if snapshot && selectedFile && (selectedCommit || changesSelected)}
              <CommitFileDiffViewer
                client={gitClient!}
                repositoryId={activeRepoId!}
                snapshot={snapshot!}
                diffSource={changesSelected ? selectedFileSource : "commit"}
                selectedCommit={selectedCommit}
                selectedFile={selectedFile!}
                onClose={closeDiff}
              onApplyHunks={applySelectedHunks}
              pending={gitActionPending}
              />
            {:else}
              <Sidebar
                {snapshot}
                {selectedCommit}
                stateKey={sidebarStateKey}
                visibleRefKeys={visibleGraphRefKeys}
                onSelectRef={selectRef}
                onSwitchBranch={switchBranch}
                onSwitchWorktree={switchWorktree}
                onToggleRefs={toggleGraphRefs}
              />
            {/if}
          {/snippet}

          {#snippet pane1()}
            {#if snapshot && selectedFile && (selectedCommit || changesSelected)}
              <div class="h-full" aria-hidden="true"></div>
            {:else}
              <div class="flex h-full min-h-0 flex-col overflow-hidden">
                <HistoryToolbar
                  onFetch={fetchRepository}
                  onPull={pullRepository}
                  onPush={pushRepository}
                  onBranch={openBranchDialog}
                  onStash={openStashDialog}
                  onPop={popStash}
                  pending={gitActionPending}
                  pendingKind={gitAction?.kind ?? null}
                />
                <div class="min-h-0 flex-1">
                  {#key activeRepoId}
                    <GitGraph
                      snapshot={graphSnapshot}
                      repositoryId={activeRepoId}
                      getRestoredScrollTop={graphScrollTopFor}
                      {selectedCommit}
                      {changesSelected}
                      {scrollToCommit}
                      onScrollTopChange={rememberGraphScrollTop}
                      onScrollCommandHandled={finishScrollToCommit}
                      onSelectChanges={selectChanges}
                      onSelectCommit={selectCommit}
                    />
                  {/key}
                </div>
              </div>
            {/if}
          {/snippet}

          {#snippet pane2()}
            {#if snapshot && changesSelected}
              <WorkingTreePanel
                {snapshot}
                selectedPaths={selectedChangePaths}
                selectedPathsSource={selectedChangeSource}
                onSelectionPathsChange={selectChangePaths}
                onSelectFile={selectFile}
                onStageFile={stageFile}
                onStagePaths={stagePaths}
                onUnstageFile={unstageFile}
                onUnstagePaths={unstagePaths}
                onStageAll={stageAll}
                onUnstageAll={unstageAll}
                onCommit={commitChanges}
            draft={activeCommitDraft}
            {amendInfo}
            {amendLoading}
            onDraftChange={changeCommitDraft}
            onAmendToggle={toggleAmend}
            onDiscardPaths={openDiscard}
            disabled={gitActionPending}
                pending={gitActionPending}
                commitPending={commitPending}
                stageActionRunning={stageActionRunning}
                stageQueueWaiting={stageQueueWaiting}
                stageQueueLabel={stageQueueLabel}
              />
            {:else if snapshot && selectedCommit}
              <CommitDetailsPanel
                client={gitClient!}
                repositoryId={activeRepoId!}
                {snapshot}
                {selectedCommit}
                {selectedFile}
                onSelectFile={selectFile}
              />
            {:else if snapshot}
              <RepositoryDetailsPanel {snapshot} />
            {:else}
              <EmptyDetailsPanel />
            {/if}
          {/snippet}
        </ResizablePaneGroup>
      </div>
      {/if}
    {/if}
  </section>
  {#if activeView === "repo" && activeRepo}
    <GitActionStatusBar label={activeWorkingTreeAction?.label ?? null} />
  {/if}
</main>

<DiscardChangesDialog open={discardDialog !== null} files={discardDialog?.files ?? []}
  loading={discardDialog?.loading ?? false} error={discardDialog?.error ?? ""}
  onConfirm={confirmDiscard} onCancel={() => { discardDialog = null; }} />

<RepositoryPathDialog
  open={repositoryPathDialogOpen}
  value={repositoryPathValue}
  error={repositoryPathError}
  loading={operationPending}
  onValueChange={(value) => {
    repositoryPathValue = value;
    repositoryPathError = "";
  }}
  onSubmit={submitRepositoryPath}
  onCancel={closeRepositoryPathDialog}
/>

<GitNameDialog
  open={gitNameDialogKind !== null}
  kind={gitNameDialogKind ?? "branch"}
  value={gitNameDialogValue}
  loading={gitActionPending}
  error={gitNameDialogError}
  onValueChange={(value) => {
    gitNameDialogValue = value;
    gitNameDialogError = "";
  }}
  onSubmit={submitGitNameDialog}
  onCancel={closeGitNameDialog}
/>
