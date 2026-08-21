<script lang="ts">
import { onDestroy, onMount } from "svelte";
  import { toast } from "svelte-sonner";
  import {
    ClientWorkspace,
    GitGuiClient,
    LocalStorageWorkspaceMetadataAdapter,
    type ClientWorkspaceState,
  } from "$lib/client-runtime";
  import CommitDetailsPanel from "$lib/components/CommitDetailsPanel.svelte";
  import CommitFileDiffViewer from "$lib/components/CommitFileDiffViewer.svelte";
  import EmptyDetailsPanel from "$lib/components/EmptyDetailsPanel.svelte";
  import GitActionStatusBar from "$lib/components/GitActionStatusBar.svelte";
  import GitGraph from "$lib/components/GitGraph.svelte";
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
    type WorkingTreeDiffSource,
  } from "$lib/components/WorkingTreePanel.svelte";
  import type { ChangedFile, RepositorySummary } from "$lib/generated/protocol";
  import type { CommitFile, CommitInfo, CommitRef, RepositorySnapshot } from "$lib/types/repository";
  import { graphRefKey, isCurrentBranchRef } from "$lib/types/branch-visibility";

  type ActiveView = "start" | "repo" | "settings";
  type SelectedGraphItem = { type: "changes" } | { type: "commit"; commit: CommitInfo };
  type LayoutStorage = {
    sidebarWidth?: number;
    detailsWidth?: number;
  };
  type BackendWorkspaceRepo = {
    id: string;
    title: string;
    root: string;
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
  };
  type RepositoryListItem = {
    repositoryId: string;
    root: string;
    title: string;
  };
  type LocalServerConnection = {
    httpUrl: string;
    websocketUrl: string;
    sessionToken: string;
    serverId: string;
    protocolVersion: number;
    capabilities: string[];
  };
  type RuntimeHandle = {
    client: GitGuiClient;
    workspace: ClientWorkspace;
    unsubscribeWorkspace: (() => void) | null;
    unsubscribeClient: (() => void) | null;
  };
  type BootstrapOptions = {
    restartServer?: boolean;
  };
  type BrowserServerConnection = {
    httpUrl: string;
    sessionToken?: string;
  };
  type GitActionKind =
    | "stage"
    | "unstage"
    | "commit"
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
  };
  type PendingGitAction = GitActionRequest & {
    repositoryId: string;
  };

  const layoutStorageKey = "gitgui.workspaceLayout.v1";
  const branchGraphVisibilityStoragePrefix = "gitgui.branchGraphVisibility.v1";
  const autoRefreshMs = 30_000;
  const initialPrefetchCommitCount = 20;
  const localEnvironmentId = "desktop-local";
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
  let queuedGitActions = $state<PendingGitAction[]>([]);
  let scrollToCommit = $state<{ id: number; repositoryId: string; hash: string } | null>(null);
  let largeScreen = $state(false);
  let sidebarWidth = $state(sidebarLimits.default);
  let detailsWidth = $state(detailsLimits.default);
  let activeWorkspaceRequest = 0;
  let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let largeScreenMediaQuery: MediaQueryList | null = null;
  let activeRuntime: RuntimeHandle | null = null;
  let bootstrapGeneration = 0;
  let pageDestroyed = false;
  let connectionError = $state(false);
  let desktopRuntime = false;
  let repositoryPathDialogOpen = $state(false);
  let repositoryPathValue = $state("");
  let repositoryPathError = $state("");
  let gitNameDialogKind = $state<"branch" | "stash" | null>(null);
  let gitNameDialogValue = $state("");
  let gitNameDialogError = $state("");
  let loadedBranchVisibilityKey = $state<string | null | undefined>(undefined);
  let hiddenGraphRefKeys = $state<Set<string>>(new Set());
  let filteredGraphViews = $state<Map<string, FilteredGraphView>>(new Map());
  let lastGraphRequestKey: string | null = null;
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
  const commitPending = $derived(activeWorkingTreeAction?.kind === "commit");
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
      branch: repo.snapshot?.status.currentBranch ?? "Detached HEAD",
      loading: repo.loading,
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

    if (filteredGraphView?.key === key) {
      lastGraphRequestKey = key;
      return;
    }

    if (!graphHasHiddenRefs) {
      lastGraphRequestKey = key;
      return;
    }

    if (key === lastGraphRequestKey) {
      return;
    }

    lastGraphRequestKey = key;
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
        });
        filteredGraphViews = nextViews;
      })
      .catch(() => undefined);
  });

  onMount(() => {
    desktopRuntime = isTauriRuntime();
    restoreLayout();
    largeScreenMediaQuery = window.matchMedia("(min-width: 1024px)");
    largeScreen = largeScreenMediaQuery.matches;
    largeScreenMediaQuery.addEventListener("change", updateLargeScreen);
    void bootstrapWorkspace();
    if (!autoRefreshTimer) {
      autoRefreshTimer = setInterval(refreshOpenRepositories, autoRefreshMs);
    }
    window.addEventListener("focus", refreshOpenRepositories);
    document.addEventListener("visibilitychange", refreshWhenVisible);
  });

  onDestroy(() => {
    pageDestroyed = true;
    bootstrapGeneration += 1;

    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }

    window.removeEventListener("focus", refreshOpenRepositories);
    document.removeEventListener("visibilitychange", refreshWhenVisible);
    largeScreenMediaQuery?.removeEventListener("change", updateLargeScreen);
    disposeActiveRuntime("GitGui page destroyed");
  });

  function updateLargeScreen(event: MediaQueryListEvent) {
    largeScreen = event.matches;
  }

  async function bootstrapWorkspace(options: BootstrapOptions = {}) {
    const generation = ++bootstrapGeneration;
    bootstrapping = true;
    if (!options.restartServer) {
      startError = "";
      connectionError = false;
    }

    disposeActiveRuntime(options.restartServer ? "Restarting the local GitGui server" : "Replacing GitGui runtime");

    let connectedClient: GitGuiClient | null = null;
    let runtime: RuntimeHandle | null = null;
    let retainRuntime = false;

    try {
      const connection = desktopRuntime
        ? await invokeDesktop<LocalServerConnection>(
            options.restartServer ? "restart_local_server" : "get_local_server_connection",
          )
        : readBrowserServerConnection();
      if (!isCurrentBootstrap(generation)) {
        return;
      }

      connectedClient = new GitGuiClient({
        endpoint: connection.httpUrl,
        ...(connection.sessionToken ? { sessionToken: connection.sessionToken } : {}),
        ...(desktopRuntime
          ? { expectedProtocolVersion: (connection as LocalServerConnection).protocolVersion }
          : {}),
      });
      const unsubscribeClient = connectedClient.onStateChange(({ current, error }) => {
        if (isCurrentBootstrap(generation) && isConnectionFailureState(current)) {
          connectionError = true;
          startError = error?.message ?? `GitGui server connection ${current}.`;
          activeView = "start";
        }
      });

      const welcome = await connectedClient.connect();
      if (!isCurrentBootstrap(generation)) {
        unsubscribeClient();
        return;
      }

      const serverId = desktopRuntime
        ? (connection as LocalServerConnection).serverId
        : welcome.server_id;
      runtime = {
        client: connectedClient,
        workspace: new ClientWorkspace({
          client: connectedClient,
          identity: {
            environmentId: desktopRuntime ? localEnvironmentId : `browser-direct:${serverId}`,
            serverId,
          },
          metadataAdapter: new LocalStorageWorkspaceMetadataAdapter(localStorage),
        }),
        unsubscribeWorkspace: null,
        unsubscribeClient,
      };

      await runtime.workspace.restore();
      if (!isCurrentBootstrap(generation)) {
        return;
      }

      activeRuntime = runtime;
      gitClient = runtime.client;
      clientWorkspace = runtime.workspace;
      runtime.unsubscribeWorkspace = runtime.workspace.subscribe((state) => {
        if (isCurrentBootstrap(generation) && activeRuntime === runtime) {
          applyWorkspaceState(state);
        }
      });

      await refreshRepositoryCatalog(connectedClient);
      if (!isCurrentBootstrap(generation)) {
        return;
      }

      if (!desktopRuntime && !runtime.workspace.state.openRepositoryIds.length && repositoryCatalog.length === 1) {
        await runtime.workspace.openKnownRepository(repositoryCatalog[0].id);
        if (!isCurrentBootstrap(generation)) {
          return;
        }
      }

      connectionError = false;
      if (startError === "Restarting the local GitGui server…") {
        startError = "";
      }
      if (activeView !== "settings") {
        activeView = activeRepoId ? "repo" : "start";
      }
      retainRuntime = true;
    } catch (caught) {
      if (isCurrentBootstrap(generation)) {
        startError = formatError(caught);
        connectionError = true;
        activeView = "start";
      }
    } finally {
      if (!retainRuntime && runtime) {
        if (activeRuntime === runtime) {
          disposeActiveRuntime("GitGui bootstrap attempt ended");
        } else {
          disposeRuntime(runtime, "GitGui bootstrap attempt became stale");
        }
      } else if (!retainRuntime && connectedClient) {
        connectedClient.disconnect("GitGui bootstrap attempt ended");
      }

      if (isCurrentBootstrap(generation)) {
        bootstrapping = false;
      }
    }
  }

  async function retryLocalConnection() {
    if (bootstrapping) {
      return;
    }

    activeView = "start";
    connectionError = true;
    startError = "Restarting the local GitGui server…";
    await bootstrapWorkspace({ restartServer: desktopRuntime });
  }

  function isTauriRuntime() {
    return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  }

  async function invokeDesktop<T>(command: string): Promise<T> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(command);
  }

  function readBrowserServerConnection(): BrowserServerConnection {
    const pageUrl = new URL(window.location.href);
    const endpoint = pageUrl.searchParams.get("server")?.trim() || window.location.origin;
    const fragment = new URLSearchParams(pageUrl.hash.replace(/^#/, ""));
    const sessionToken = fragment.get("session_token")?.trim();

    if (!endpoint) {
      throw new Error(
        "Browser mode needs a GitGui server URL, or the page must be served by GitGui itself.",
      );
    }

    const serverUrl = new URL(endpoint);
    const isLoopback = serverUrl.hostname === "127.0.0.1"
      || serverUrl.hostname === "localhost"
      || serverUrl.hostname === "[::1]";
    if (serverUrl.protocol !== "https:" && !(serverUrl.protocol === "http:" && isLoopback)) {
      throw new Error("Browser connections require HTTPS, except for a loopback development server.");
    }
    if (window.location.protocol === "https:" && serverUrl.protocol !== "https:") {
      throw new Error("An HTTPS GitGui page requires an HTTPS/WSS GitGui server.");
    }

    pageUrl.hash = "";
    window.history.replaceState(window.history.state, "", pageUrl);
    return {
      httpUrl: serverUrl.toString(),
      ...(sessionToken ? { sessionToken } : {}),
    };
  }

  function isConnectionError(caught: unknown) {
    if (typeof caught !== "object" || caught === null || !("code" in caught)) {
      return false;
    }

    const code = caught.code;
    return typeof code === "string"
      && [
        "connection_failed",
        "not_connected",
        "websocket_unavailable",
        "incompatible_protocol",
        "unauthorized",
        "authentication_required",
        "forbidden",
        "disconnected",
      ].includes(code);
  }

  function isCurrentBootstrap(generation: number) {
    return !pageDestroyed && generation === bootstrapGeneration;
  }

  function isConnectionFailureState(state: string) {
    return state === "failed"
      || state === "incompatible"
      || state === "unauthorized"
      || state === "disconnected";
  }

  function disposeActiveRuntime(reason: string) {
    const runtime = activeRuntime;
    activeRuntime = null;
    gitClient = null;
    clientWorkspace = null;

    if (runtime) {
      disposeRuntime(runtime, reason);
    }
  }

  function disposeRuntime(runtime: RuntimeHandle, reason: string) {
    runtime.unsubscribeWorkspace?.();
    runtime.unsubscribeClient?.();
    runtime.unsubscribeWorkspace = null;
    runtime.unsubscribeClient = null;
    runtime.client.disconnect(reason);
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
    const { open } = await import("@tauri-apps/plugin-dialog");
    return open({
      directory: true,
      multiple: false,
      title: "Open repository",
    });
  }

  async function openRepository(repositoryId: string) {
    await runWorkspaceCommand(() => requireWorkspace().openKnownRepository(repositoryId));
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
        ? reconcileSelectedFile(previousRepo?.selectedFile ?? null, snapshot)
        : previousRepo?.selectedFile ?? null;

      return [{
        id: repositoryState.repository.id,
        title: repositoryTitle(repositoryState.repository),
        root: repositoryState.repository.root,
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

  function refreshWhenVisible() {
    if (document.visibilityState === "visible") {
      void refreshOpenRepositories();
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
    const merged = new Map(repositories.map((repository) => [repository.id, repository]));

    for (const repositoryState of state ? Object.values(state.repositories) : []) {
      merged.set(repositoryState.repository.id, repositoryState.repository);
    }

    return [...merged.values()];
  }

  function repositoryTitle(repository: RepositorySummary) {
    const normalizedRoot = repository.root.replace(/[\\/]+$/, "");
    const separator = Math.max(normalizedRoot.lastIndexOf("/"), normalizedRoot.lastIndexOf("\\"));
    return normalizedRoot.slice(separator + 1) || repository.root;
  }

  const homeRepositories = $derived<RepositoryListItem[]>(
    repositoryCatalog.map((repository) => ({
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

  function reconcileSelectedFile(currentFile: CommitFile | null, nextSnapshot: RepositorySnapshot) {
    if (!currentFile) {
      return null;
    }

    const nextChangedFile = nextSnapshot.status.changedFiles.find((file) => file.path === currentFile.path);

    if (!nextChangedFile) {
      return null;
    }

    return currentFile;
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

    try {
      await request.action(request.repositoryId);
      await workspace.refreshRepository(request.repositoryId);
      if (request.notifySuccess !== false && request.successMessage) {
        toast.success(request.successMessage);
      }
    } catch (caught) {
      // Pull and stash-pop can leave conflict markers or partial changes even
      // when Git exits non-zero, so make the visible working tree authoritative
      // before surfacing the error.
      await workspace.refreshRepository(request.repositoryId).catch(() => undefined);
      toast.error(formatError(caught), { description: `${request.label} failed` });
    } finally {
      gitAction = null;
      const nextAction = queuedGitActions[0];
      queuedGitActions = queuedGitActions.slice(1);
      if (nextAction) {
        void runGitAction(nextAction);
      }
    }
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
    requestGitAction({
      kind: "commit",
      label: "Committing",
      successMessage: "Changes committed",
      action: (repositoryId) => gitClient!.commit({
        repositoryId,
        summary: draft.summary,
        ...(draft.description ? { description: draft.description } : {}),
      }),
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
    {:else if activeView === "start" || !activeRepo}
      <StartView
        repositories={homeRepositories}
        {loading}
        error={startError}
        {connectionError}
        onChooseRepository={chooseRepository}
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
            />
          </div>
        {:else}
          <Sidebar
            {snapshot}
            {selectedCommit}
            stateKey={sidebarStateKey}
            visibleRefKeys={visibleGraphRefKeys}
            onSelectRef={selectRef}
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
              />
            {:else}
              <Sidebar
                {snapshot}
                {selectedCommit}
                stateKey={sidebarStateKey}
                visibleRefKeys={visibleGraphRefKeys}
                onSelectRef={selectRef}
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
