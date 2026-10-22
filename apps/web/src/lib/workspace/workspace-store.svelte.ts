/**
 * The application workspace.
 *
 * This is the single owner of client-local workspace state: open repository
 * tabs and their selection, pending Git actions, commit drafts, dialog state,
 * and layout preferences. Svelte routes read this store and call its actions.
 *
 * Two rules define the boundary between the store and the URL:
 *
 * - The URL owns what is on screen. The store owns which repositories are
 *   open and remembers the last active repository so a cold start can resume.
 * - The store never owns a socket, a retry, or a credential. It consumes the
 *   connection runtime's projected state and nothing else.
 */
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { browser } from "$app/environment";
import { toast } from "svelte-sonner";
import type { GitGuiClient } from "@gitgui/client-runtime";
import type {
  ChangedFile,
  GitAmendInfo,
  GitApplyHunksParams,
  GitDiscardFile,
  RepositorySummary,
} from "@gitgui/contracts";
import { type ClientWorkspace, type ClientWorkspaceState } from "$lib/client-runtime";
import { reconcileWorkingTreeFile } from "$lib/client-runtime/file-selection";
import { readDesktopBridge } from "$lib/connection/platform";
import type { WebApplicationRuntime, WebApplicationRuntimeState } from "$lib/connection/runtime";
import { readBranchSwitchMergePreference, resolveProjectsLocation } from "$lib/preferences";
import { graphRefKey, isCurrentBranchRef } from "$lib/types/branch-visibility";
import type { CommitFile, CommitInfo, CommitRef, RepositorySnapshot } from "$lib/types/repository";
import type { RepoTab } from "$lib/components/TopMenu.svelte";
import type { ResizablePane } from "$lib/components/ResizablePaneGroup.svelte";
import type {
  CommitMessageDraft,
  WorkingTreeDiffSource,
  WorkingTreeDraftState,
} from "$lib/components/WorkingTreePanel.svelte";
import { formatError, isConnectionError, summarizeGitError } from "./errors";
import {
  persistHiddenGraphRefKeys,
  persistLayoutPreferences,
  readHiddenGraphRefKeys,
  readLayoutPreferences,
} from "./preferences";
import { HOME_ROUTE_ID, repositoryIdFromParam, repositoryPath } from "./routes";
import { resolveClosedRepositoryTarget } from "./repository-routing";
import { resolveDeepLinkTarget } from "./deep-links";
import type {
  FilteredGraphView,
  GitActionRequest,
  PendingGitAction,
  RepositoryListItem,
  WorkspaceRepo,
} from "./types";

const initialPrefetchCommitCount = 20;
const sidebarLimits = { default: 230, min: 180, max: 420 };
const detailsLimits = { default: 430, min: 300, max: 620 };

const emptyDraft = (): WorkingTreeDraftState => ({
  normal: { summary: "", description: "" },
  amend: { summary: "", description: "" },
  amendMode: false,
  amendHead: null,
});

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value)));

export class WorkspaceStore {
  /* ---------------------------------------------------------------------- */
  /* Connection runtime projection                                            */
  /* ---------------------------------------------------------------------- */

  readonly isDesktop: boolean;

  client = $state<GitGuiClient | null>(null);
  workspace = $state<ClientWorkspace | null>(null);
  workspaceState = $state<ClientWorkspaceState | null>(null);
  bootstrapping = $state(false);
  connectionError = $state(false);
  startError = $state("");
  operationPending = $state(false);

  /* ---------------------------------------------------------------------- */
  /* Repositories                                                            */
  /* ---------------------------------------------------------------------- */

  repositoryCatalog = $state<RepositorySummary[]>([]);
  openRepos = $state<WorkspaceRepo[]>([]);
  activeRepositoryId = $state<string | null>(null);

  /* ---------------------------------------------------------------------- */
  /* Git actions                                                             */
  /* ---------------------------------------------------------------------- */

  gitAction = $state<{ repositoryId: string; kind: string; label: string } | null>(null);
  queuedGitActions = $state<PendingGitAction[]>([]);
  commitDrafts = $state<Record<string, WorkingTreeDraftState>>({});
  amendInfo = $state<GitAmendInfo | null>(null);
  amendLoading = $state(false);

  /* ---------------------------------------------------------------------- */
  /* Graph                                                                   */
  /* ---------------------------------------------------------------------- */

  hiddenGraphRefKeys = $state<Set<string>>(new Set());
  filteredGraphViews = $state<Map<string, FilteredGraphView>>(new Map());
  scrollToCommit = $state<{ id: number; repositoryId: string; hash: string } | null>(null);
  /** The repository whose branch visibility preference is loaded. */
  private loadedBranchVisibilityKey = $state<string | null | undefined>(undefined);

  /* ---------------------------------------------------------------------- */
  /* Layout                                                                  */
  /* ---------------------------------------------------------------------- */

  sidebarWidth = $state(sidebarLimits.default);
  detailsWidth = $state(detailsLimits.default);
  largeScreen = $state(false);

  /* ---------------------------------------------------------------------- */
  /* Dialogs                                                                 */
  /* ---------------------------------------------------------------------- */

  discardDialog = $state<{
    repositoryId: string;
    environmentId: string;
    files: GitDiscardFile[];
    loading: boolean;
    error: string;
    client: GitGuiClient;
  } | null>(null);
  repositoryPathDialogOpen = $state(false);
  repositoryPathValue = $state("");
  repositoryPathError = $state("");
  gitNameDialogKind = $state<"branch" | "stash" | null>(null);
  gitNameDialogValue = $state("");
  gitNameDialogError = $state("");

  /* ---------------------------------------------------------------------- */
  /* Create repository                                                       */
  /* ---------------------------------------------------------------------- */

  createRepositoryParentPath = $state("");
  createRepositoryName = $state("");
  createRepositoryInitialBranch = $state("");
  createRepositoryInitializeLfs = $state(false);
  createRepositoryError = $state("");
  /** True once the create form has been filled with its defaults. */
  createRepositoryPrepared = $state(false);

  /* ---------------------------------------------------------------------- */
  /* Route state                                                             */
  /* ---------------------------------------------------------------------- */

  /** The route id SvelteKit reports for the current page. */
  currentRouteId = $derived(page.route.id);
  /** The repository the URL points at, or null on every other route. */
  routedRepositoryId = $derived(repositoryIdFromParam(page.params.repositoryId));

  /* ---------------------------------------------------------------------- */
  /* Derived state                                                           */
  /* ---------------------------------------------------------------------- */

  activeRepository = $derived(
    this.openRepos.find((repo) => repo.id === this.activeRepositoryId) ?? null,
  );
  snapshot = $derived(this.activeRepository?.snapshot ?? null);
  gitActionPending = $derived(this.gitAction !== null);
  activeWorkingTreeAction = $derived(
    this.gitAction?.repositoryId === this.activeRepositoryId ? this.gitAction : null,
  );
  commitPending = $derived(
    this.activeWorkingTreeAction?.kind === "commit" || this.activeWorkingTreeAction?.kind === "amend",
  );
  stageActionRunning = $derived(
    this.activeWorkingTreeAction?.kind === "stage" || this.activeWorkingTreeAction?.kind === "unstage",
  );
  queuedStageAction = $derived(
    this.queuedGitActions.find(
      (action) =>
        action.repositoryId === this.activeRepositoryId &&
        (action.kind === "stage" || action.kind === "unstage"),
    ) ?? null,
  );
  stageQueueWaiting = $derived(
    this.gitAction !== null && this.queuedStageAction !== null && !this.stageActionRunning,
  );
  stageQueueLabel = $derived(this.queuedStageAction?.label ?? null);

  /** Identifies the per-environment, per-repository selection and drafts. */
  sidebarStateKey = $derived(
    this.workspaceState?.environmentId && this.activeRepositoryId
      ? `${this.workspaceState.environmentId}:${this.activeRepositoryId}`
      : null,
  );
  activeCommitDraft = $derived(this.commitDrafts[this.sidebarStateKey ?? ""] ?? emptyDraft());

  graphVisibilityReady = $derived(
    !this.activeRepositoryId ||
      (this.sidebarStateKey !== null && this.loadedBranchVisibilityKey === this.sidebarStateKey),
  );
  visibleGraphRefs = $derived(
    (this.snapshot?.refs ?? []).filter(
      (ref) =>
        ref.refType === "tag" ||
        isCurrentBranchRef(ref, this.snapshot?.status.currentBranch) ||
        !this.hiddenGraphRefKeys.has(graphRefKey(ref)),
    ),
  );
  visibleGraphRefKeys = $derived(new Set(this.visibleGraphRefs.map((ref) => graphRefKey(ref))));
  graphTargetCommitHashes = $derived([
    ...new Set([
      ...(this.snapshot?.status.headOid ? [this.snapshot.status.headOid] : []),
      ...this.visibleGraphRefs.map((ref) => ref.target),
    ]),
  ]);
  graphTargetKey = $derived(
    this.activeRepositoryId && this.snapshot
      ? `${this.activeRepositoryId}\0${this.visibleGraphRefs
          .map((ref) => `${graphRefKey(ref)}\0${ref.target}`)
          .join("\0")}\0${this.graphTargetCommitHashes.join("\0")}`
      : null,
  );
  filteredGraphView = $derived(
    this.activeRepositoryId ? this.filteredGraphViews.get(this.activeRepositoryId) ?? null : null,
  );
  graphHasHiddenRefs = $derived(
    Boolean(
      this.snapshot?.refs.some(
        (ref) =>
          ref.refType !== "tag" &&
          !isCurrentBranchRef(ref, this.snapshot?.status.currentBranch) &&
          this.hiddenGraphRefKeys.has(graphRefKey(ref)),
      ),
    ),
  );
  graphSnapshot = $derived(
    !this.snapshot || !this.graphVisibilityReady
      ? null
      : this.filteredGraphView?.key === this.graphTargetKey ||
          (this.filteredGraphView && this.graphHasHiddenRefs)
        ? {
            ...this.snapshot,
            commits: this.filteredGraphView.commits,
            graph: this.filteredGraphView.graph,
            refs: this.filteredGraphView.refs,
          }
        : this.graphHasHiddenRefs
          ? null
          : this.snapshot,
  );

  selectedGraphItem = $derived(this.activeRepository?.selectedGraphItem ?? null);
  selectedFile = $derived(this.activeRepository?.selectedFile ?? null);
  selectedFileSource = $derived(this.activeRepository?.selectedFileSource ?? "workingTree");
  comparingCommitToWorkingTreeHash = $state<string | null>(null);
  selectedChangePaths = $derived(this.activeRepository?.selectedChangePaths ?? []);
  selectedChangeSource = $derived(this.activeRepository?.selectedChangeSource ?? "workingTree");
  selectedCommit = $derived(
    this.selectedGraphItem?.type === "commit" ? this.selectedGraphItem.commit : null,
  );
  comparingCommitToWorkingTree = $derived(this.comparingCommitToWorkingTreeHash === this.selectedCommit?.hash);
  changesSelected = $derived(this.selectedGraphItem?.type === "changes");

  repoTabs = $derived<RepoTab[]>(
    this.openRepos.map((repo) => ({
      id: repo.id,
      title: repo.title,
      root: repo.root,
      isWorktree: repo.isWorktree,
      branch: repo.snapshot ? repo.snapshot.status.currentBranch ?? "Detached HEAD" : "",
      error: repo.error ?? "",
    })),
  );

  loading = $derived(
    this.bootstrapping ||
      this.operationPending ||
      this.workspaceState?.restoring === true ||
      this.workspaceState?.opening === true,
  );

  detailsPane = $derived<ResizablePane>({
    id: "details",
    minWidth: detailsLimits.min,
    maxWidth: detailsLimits.max,
    width: this.detailsWidth,
  });
  graphPanes = $derived<ResizablePane[]>([
    {
      id: "sidebar",
      minWidth: sidebarLimits.min,
      maxWidth: sidebarLimits.max,
      width: this.sidebarWidth,
    },
    {
      id: "graph",
      minWidth: 320,
      flexible: true,
    },
    this.detailsPane,
  ]);
  largeScreenPanes = $derived<ResizablePane[]>(
    this.selectedFile && (this.selectedCommit || this.changesSelected)
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
          this.detailsPane,
        ]
      : this.graphPanes,
  );

  homeRepositories = $derived<RepositoryListItem[]>(
    this.repositoryCatalog
      .filter((repository) => repository.isWorktree !== true)
      .map((repository) => ({
        repositoryId: repository.id,
        root: repository.root,
        title: this.repositoryTitle(repository),
      })),
  );

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  private readonly runtime: WebApplicationRuntime;
  private unsubscribeRuntime: (() => void) | null = null;
  private unsubscribeDeepLink: (() => void) | null = null;
  private appliedRuntimeWorkspace: ClientWorkspace | null = null;
  private largeScreenMediaQuery: MediaQueryList | null = null;
  private activeWorkspaceRequest = 0;
  private amendRequest = 0;
  private nextScrollCommandId = 0;
  private graphRequestGeneration = 0;
  private lastGraphRequestKey: string | null = null;
  private lastGraphSource: RepositorySnapshot["graph"] | null = null;
  private hasResumed = false;
  private readonly graphScrollPositions = new Map<string, number>();
  private readonly prefetchedInitialCommits = new Map<string, string>();

  constructor(runtime: WebApplicationRuntime) {
    this.runtime = runtime;
    this.isDesktop = runtime.isDesktop;

    $effect(() => {
      const client = this.client;
      const repositoryId = this.activeRepositoryId;
      const currentSnapshot = this.snapshot;
      const key = this.sidebarStateKey;
      const request = ++this.amendRequest;
      this.amendInfo = null;
      this.amendLoading = Boolean(client && repositoryId && currentSnapshot && key);
      if (!client || !repositoryId || !currentSnapshot || !key) return;
      void client
        .getAmendInfo(repositoryId)
        .then((info) => {
          if (request === this.amendRequest) this.amendInfo = info;
        })
        .catch((error) => {
          if (request === this.amendRequest) {
            this.amendInfo = {
              headOid: null,
              summary: "",
              description: "",
              blockedReason: summarizeGitError(error),
            };
          }
        })
        .finally(() => {
          if (request === this.amendRequest) this.amendLoading = false;
        });
    });

    $effect(() => {
      const dialog = this.discardDialog;
      if (
        dialog &&
        (dialog.repositoryId !== this.activeRepositoryId ||
          dialog.environmentId !== this.workspaceState?.environmentId)
      ) {
        this.discardDialog = null;
      }
    });

    $effect(() => {
      const key = this.sidebarStateKey;
      if (key === this.loadedBranchVisibilityKey) {
        return;
      }

      this.hiddenGraphRefKeys = key ? readHiddenGraphRefKeys(key) : new Set();
      this.loadedBranchVisibilityKey = key;
    });

    $effect(() => {
      const scroll = this.scrollToCommit;
      if (scroll?.repositoryId && scroll.repositoryId !== this.activeRepositoryId) {
        this.scrollToCommit = null;
      }
    });

    $effect(() => {
      const client = this.client;
      const repositoryId = this.activeRepositoryId;
      const key = this.graphTargetKey;
      const targetCommits = this.graphTargetCommitHashes;

      if (!this.graphVisibilityReady || !client || !repositoryId || !this.snapshot || !key) {
        this.lastGraphRequestKey = null;
        return;
      }

      if (this.filteredGraphView?.key === key && this.filteredGraphView.sourceGraph === this.snapshot.graph) {
        this.lastGraphRequestKey = key;
        return;
      }

      if (!this.graphHasHiddenRefs) {
        this.lastGraphRequestKey = key;
        return;
      }

      if (key === this.lastGraphRequestKey && this.lastGraphSource === this.snapshot.graph) {
        return;
      }

      this.lastGraphRequestKey = key;
      this.lastGraphSource = this.snapshot.graph;
      const sourceGraph = this.snapshot.graph;
      const generation = ++this.graphRequestGeneration;
      const targetRefs = [...this.visibleGraphRefs];

      void client
        .getRepositoryGraph({ repositoryId, targetCommits })
        .then((result) => {
          if (generation !== this.graphRequestGeneration || key !== this.lastGraphRequestKey) {
            return;
          }

          const nextViews = new Map(this.filteredGraphViews);
          nextViews.set(repositoryId, {
            repositoryId,
            key,
            refs: targetRefs,
            commits: result.commits,
            graph: result.graph,
            sourceGraph,
          });
          this.filteredGraphViews = nextViews;
        })
        .catch(() => undefined);
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                               */
  /* ---------------------------------------------------------------------- */

  start(): void {
    this.restoreLayout();
    this.largeScreenMediaQuery = window.matchMedia("(min-width: 1024px)");
    this.largeScreen = this.largeScreenMediaQuery.matches;
    this.largeScreenMediaQuery.addEventListener("change", this.updateLargeScreen);
    this.unsubscribeRuntime = this.runtime.subscribe((state) =>
      this.applyApplicationRuntimeState(state),
    );
    this.unsubscribeDeepLink = readDesktopBridge()?.onDeepLink((url) => {
      const target = resolveDeepLinkTarget(url);
      if (target) void this.navigateTo(target);
    }) ?? null;
  }

  dispose(): void {
    this.largeScreenMediaQuery?.removeEventListener("change", this.updateLargeScreen);
    this.largeScreenMediaQuery = null;
    this.unsubscribeRuntime?.();
    this.unsubscribeRuntime = null;
    this.unsubscribeDeepLink?.();
    this.unsubscribeDeepLink = null;
  }

  private updateLargeScreen = (event: MediaQueryListEvent): void => {
    this.largeScreen = event.matches;
  };

  /* ---------------------------------------------------------------------- */
  /* Navigation                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Navigate to an application path.
   *
   * The query string is preserved so a reload keeps the endpoint the client
   * was started with.
   */
  private async navigate(path: string, options: { replaceState?: boolean } = {}): Promise<void> {
    if (!browser) return;
    const target = new URL(path, page.url);
    target.search = page.url.search;
    if (target.pathname === page.url.pathname && target.search === page.url.search) return;
    await goto(`${target.pathname}${target.search}`, options);
  }

  async showStartView(): Promise<void> {
    await this.navigate("/");
  }

  async showSettingsView(): Promise<void> {
    await this.navigate("/settings/general");
  }

  async showCreateRepositoryView(): Promise<void> {
    await this.navigate("/new");
  }

  /** Navigate to an application path, keeping the query string intact. */
  async navigateTo(path: string): Promise<void> {
    await this.navigate(path);
  }

  /* ---------------------------------------------------------------------- */
  /* Runtime state                                                           */
  /* ---------------------------------------------------------------------- */

  private applyApplicationRuntimeState(state: WebApplicationRuntimeState): void {
    // Registrations survive disconnects. Their removal is the signal to
    // release environment-owned drafts, matching the runtime's cache lifetime.
    const registeredEnvironments = new Set(
      state.registry.entries.map((entry) => entry.registration.environmentId),
    );
    for (const key of Object.keys(this.commitDrafts)) {
      if (!registeredEnvironments.has(key.slice(0, key.indexOf(":")))) delete this.commitDrafts[key];
    }
    this.bootstrapping = state.loading;
    this.connectionError =
      state.connection?.phase === "blocked" || state.connection?.phase === "offline";
    this.startError = state.error;
    if (this.connectionError) {
      void this.navigate("/");
    }

    if (!state.client || !state.workspace || !state.workspaceState) return;
    this.client = state.client;
    this.workspace = state.workspace;
    this.applyWorkspaceState(state.workspaceState);
    if (this.appliedRuntimeWorkspace !== state.workspace) {
      // Only a cold start resumes. A later session replacement must not pull
      // the user out of the page they are on.
      const isColdStart = this.appliedRuntimeWorkspace === null;
      this.appliedRuntimeWorkspace = state.workspace;
      void this.refreshRepositoryCatalog(state.client)
        .then(async () => {
          if (
            !this.isDesktop &&
            !state.workspace!.state.openRepositoryIds.length &&
            this.repositoryCatalog.length === 1
          ) {
            await state.workspace!.openKnownRepository(this.repositoryCatalog[0].id);
          }
          if (isColdStart) await this.resumeActiveRepository();
        })
        .catch((caught) => {
          this.startError = formatError(caught);
          this.connectionError = true;
        });
    }
  }

  /**
   * Resume the last active repository on a cold start.
   *
   * Only the landing page resumes, and only once. A deep link or an explicit
   * settings visit keeps the URL the user asked for.
   */
  private async resumeActiveRepository(): Promise<void> {
    if (this.hasResumed) return;
    const repositoryId = this.activeRepositoryId;
    if (!repositoryId) return;
    if (this.currentRouteId !== HOME_ROUTE_ID) return;
    this.hasResumed = true;
    await this.navigate(repositoryPath(repositoryId), { replaceState: true });
  }

  private applyWorkspaceState(state: ClientWorkspaceState): void {
    this.workspaceState = state;
    const previousRepos = this.openRepos;
    this.repositoryCatalog = this.mergeRepositoryCatalog(this.repositoryCatalog, state);
    this.activeRepositoryId = state.activeRepositoryId;
    this.openRepos = state.openRepositoryIds.flatMap((repositoryId) => {
      const repositoryState = state.repositories[repositoryId];

      if (!repositoryState) {
        return [];
      }

      const snapshot = repositoryState.snapshot;
      const previousRepo = previousRepos.find((candidate) => candidate.id === repositoryId);
      const selectedGraphItem = snapshot
        ? this.reconcileSelection(previousRepo?.selectedGraphItem ?? null, snapshot)
        : previousRepo?.selectedGraphItem ?? null;
      const selectedFile = snapshot
        ? selectedGraphItem?.type === "changes"
          ? reconcileWorkingTreeFile(
              previousRepo?.selectedFile ?? null,
              previousRepo?.selectedFileSource === "staged" ? "staged" : "workingTree",
              snapshot,
            )
          : selectedGraphItem?.type === "commit" &&
              previousRepo?.selectedGraphItem?.type === "commit" &&
              selectedGraphItem.commit.hash === previousRepo.selectedGraphItem.commit.hash
            ? previousRepo.selectedFile
            : null
        : previousRepo?.selectedFile ?? null;

      return [
        {
          id: repositoryState.repository.id,
          title: this.repositoryTitle(repositoryState.repository),
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
        },
      ];
    });
    this.prunePrefetchState(this.openRepos);
    this.prefetchInitialCommitFiles(this.openRepos);

    if (state.error) {
      this.startError = state.error.message;
    }
  }

  private mergeRepositoryCatalog(
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

  repositoryTitle(repository: RepositorySummary): string {
    if (repository.name) {
      return repository.name;
    }

    const normalizedRoot = repository.root.replace(/[\\/]+$/, "");
    const separator = Math.max(normalizedRoot.lastIndexOf("/"), normalizedRoot.lastIndexOf("\\"));
    return normalizedRoot.slice(separator + 1) || repository.root;
  }

  /* ---------------------------------------------------------------------- */
  /* Repository commands                                                     */
  /* ---------------------------------------------------------------------- */

  private requireWorkspace(): ClientWorkspace {
    if (!this.workspace) {
      throw new Error("The local GitGui server is not connected.");
    }

    return this.workspace;
  }

  private async refreshRepositoryCatalog(client: GitGuiClient = this.client!): Promise<void> {
    if (!client) {
      return;
    }

    const repositories = await client.listRepositories();
    this.repositoryCatalog = this.mergeRepositoryCatalog(repositories, this.workspaceState);
    if (this.workspaceState) {
      this.applyWorkspaceState(this.workspaceState);
    }
  }

  /**
   * Run one workspace command.
   *
   * `navigate` decides whether the command moves the URL to the active
   * repository. Closing and removing a tab navigate themselves.
   */
  private async runWorkspaceCommand(
    action: () => Promise<unknown>,
    options: { navigate?: boolean } = {},
  ): Promise<boolean> {
    const request = ++this.activeWorkspaceRequest;
    this.operationPending = true;
    this.startError = "";

    try {
      await action();
      if (request === this.activeWorkspaceRequest && options.navigate !== false) {
        await this.navigateToActiveRepository();
      }
      return true;
    } catch (caught) {
      if (request === this.activeWorkspaceRequest) {
        this.startError = formatError(caught);
        if (isConnectionError(caught)) {
          this.connectionError = true;
          void this.navigate("/");
        }
      }
      return false;
    } finally {
      if (request === this.activeWorkspaceRequest) {
        this.operationPending = false;
      }
    }
  }

  private async navigateToActiveRepository(): Promise<void> {
    const repositoryId = this.activeRepositoryId;
    if (!repositoryId) return;
    await this.navigate(repositoryPath(repositoryId));
  }

  async retryLocalConnection(): Promise<void> {
    if (this.bootstrapping) return;
    this.connectionError = true;
    this.startError = this.isDesktop
      ? "Restarting the local GitGui server…"
      : "Retrying the GitGui connection…";
    await this.navigate("/");
    try {
      await this.runtime.retrySelected(this.isDesktop);
    } catch (caught) {
      this.startError = formatError(caught);
    }
  }

  async chooseRepository(): Promise<void> {
    this.startError = "";

    if (!this.isDesktop) {
      this.repositoryPathValue = "";
      this.repositoryPathError = "";
      this.repositoryPathDialogOpen = true;
      return;
    }

    try {
      const selectedPath = await this.runtime.pickFolder();

      if (typeof selectedPath === "string") {
        await this.runWorkspaceCommand(() => this.requireWorkspace().openRepositoryPath(selectedPath));
      }
    } catch (caught) {
      this.startError = formatError(caught);
    }
  }

  async openRepository(repositoryId: string): Promise<boolean> {
    return this.runWorkspaceCommand(() => this.requireWorkspace().openKnownRepository(repositoryId));
  }

  async removeRepository(repositoryId: string): Promise<void> {
    const draftKey = this.workspaceState?.environmentId
      ? `${this.workspaceState.environmentId}:${repositoryId}`
      : null;
    const removed = await this.runWorkspaceCommand(
      () => this.requireWorkspace().removeRepository(repositoryId),
      { navigate: false },
    );
    if (removed) {
      if (draftKey) delete this.commitDrafts[draftKey];
      this.repositoryCatalog = this.repositoryCatalog.filter(
        (repository) => repository.id !== repositoryId,
      );
      await this.navigate("/");
    }
  }

  async selectRepository(repositoryId: string): Promise<void> {
    await this.runWorkspaceCommand(() => this.requireWorkspace().selectRepository(repositoryId));
  }

  async closeRepository(repositoryId: string): Promise<void> {
    const wasRouted = this.routedRepositoryId === repositoryId;
    await this.runWorkspaceCommand(() => this.requireWorkspace().closeRepository(repositoryId), {
      navigate: false,
    });

    if (!wasRouted) return;
    // The closed tab owned the URL. Move to the next repository, or home when
    // this was the last one.
    await this.navigate(resolveClosedRepositoryTarget(this.activeRepositoryId));
  }

  async switchWorktree(path: string): Promise<void> {
    const repositoryId = this.activeRepositoryId;
    if (!path.trim() || !repositoryId || !this.workspace || this.operationPending) {
      return;
    }

    void this.runWorkspaceCommand(() =>
      this.requireWorkspace().switchRepositoryPath(path, repositoryId),
    );
  }

  closeRepositoryPathDialog(): void {
    if (!this.operationPending) {
      this.repositoryPathDialogOpen = false;
      this.repositoryPathError = "";
    }
  }

  async submitRepositoryPath(): Promise<void> {
    const path = this.repositoryPathValue.trim();
    if (!path) {
      this.repositoryPathError = "Enter a repository path on the connected host.";
      return;
    }

    this.repositoryPathError = "";
    const opened = await this.runWorkspaceCommand(() =>
      this.requireWorkspace().openRepositoryPath(path),
    );
    if (opened) {
      this.repositoryPathDialogOpen = false;
      this.repositoryPathValue = "";
    } else {
      this.repositoryPathError = this.startError || "The repository could not be opened.";
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Create repository                                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Reset the create form to its defaults.
   *
   * The form is prepared before the page is shown, so the default project
   * location is already in place when the page appears.
   */
  async prepareCreateRepository(): Promise<void> {
    this.createRepositoryParentPath = await resolveProjectsLocation();
    this.createRepositoryName = "";
    this.createRepositoryInitialBranch = "";
    this.createRepositoryInitializeLfs = false;
    this.createRepositoryError = "";
    this.createRepositoryPrepared = true;
  }

  async beginCreateRepository(): Promise<void> {
    await this.prepareCreateRepository();
    await this.showCreateRepositoryView();
  }

  async submitCreateRepository(): Promise<void> {
    const name = this.createRepositoryName.trim();
    if (!name) {
      this.createRepositoryError = "Enter a repository name to continue.";
      return;
    }
    if (name === "." || name === ".." || /[\\/:]/.test(name)) {
      this.createRepositoryError = "Use a single folder name without slashes or a drive prefix.";
      return;
    }

    this.createRepositoryError = "";
    const created = await this.runWorkspaceCommand(() =>
      this.requireWorkspace().createRepository(this.createRepositoryParentPath.trim(), name, {
        ...(this.createRepositoryInitialBranch.trim()
          ? { initialBranch: this.createRepositoryInitialBranch.trim() }
          : {}),
        initializeLfs: this.createRepositoryInitializeLfs,
      }),
    );
    if (created) {
      this.createRepositoryParentPath = "";
      this.createRepositoryName = "";
      this.createRepositoryInitialBranch = "";
      this.createRepositoryInitializeLfs = false;
    } else {
      this.createRepositoryError = this.startError || "The repository could not be created.";
    }
  }

  async browseCreateRepositoryLocation(): Promise<void> {
    if (!this.isDesktop) {
      return;
    }

    try {
      const selectedPath = await this.runtime.pickFolder();
      if (typeof selectedPath === "string") {
        this.createRepositoryParentPath = selectedPath;
        this.createRepositoryError = "";
      }
    } catch (caught) {
      this.createRepositoryError = formatError(caught);
    }
  }

  async closeCreateRepositoryView(): Promise<void> {
    if (!this.operationPending) {
      this.createRepositoryError = "";
      this.createRepositoryPrepared = false;
      await this.showStartView();
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Selection                                                               */
  /* ---------------------------------------------------------------------- */

  private updateActiveRepository(update: (repo: WorkspaceRepo) => WorkspaceRepo): void {
    if (!this.activeRepositoryId) {
      return;
    }

    this.openRepos = this.openRepos.map((repo) =>
      repo.id === this.activeRepositoryId ? update(repo) : repo,
    );
  }

  selectCommit(commit: CommitInfo): void {
    this.comparingCommitToWorkingTreeHash = null;
    this.updateActiveRepository((repo) => ({
      ...repo,
      selectedGraphItem: { type: "commit", commit },
      selectedFile: null,
      selectedFileSource: null,
      selectedChangePaths: [],
      selectedChangeSource: null,
    }));
  }

  compareCommitToWorkingTree(commit: CommitInfo): void {
    this.comparingCommitToWorkingTreeHash = commit.hash;
    this.selectCommit(commit);
    this.comparingCommitToWorkingTreeHash = commit.hash;
  }

  selectRef(ref: CommitRef): void {
    const commit = this.snapshot?.commits.find((candidate) => candidate.hash === ref.target);
    if (commit && this.activeRepositoryId) {
      this.scrollToCommit = {
        id: ++this.nextScrollCommandId,
        repositoryId: this.activeRepositoryId,
        hash: commit.hash,
      };
      this.selectCommit(commit);
    }
  }

  selectChanges(): void {
    this.comparingCommitToWorkingTreeHash = null;
    this.updateActiveRepository((repo) => ({
      ...repo,
      selectedGraphItem: { type: "changes" },
      selectedFile: null,
      selectedFileSource: null,
      selectedChangePaths: [],
      selectedChangeSource: null,
    }));
  }

  selectFile(file: CommitFile, source: WorkingTreeDiffSource = "workingTree"): void {
    this.updateActiveRepository((repo) => ({
      ...repo,
      selectedFile: file,
      selectedFileSource: source,
      selectedChangeSource:
        repo.selectedGraphItem?.type === "changes" ? source : repo.selectedChangeSource,
    }));
  }

  selectChangePaths(paths: string[], source: WorkingTreeDiffSource): void {
    this.updateActiveRepository((repo) => ({
      ...repo,
      selectedChangePaths: paths,
      selectedChangeSource: source,
    }));
  }

  closeDiff(): void {
    this.updateActiveRepository((repo) => ({
      ...repo,
      selectedFile: null,
      selectedFileSource: null,
      selectedChangePaths: [],
      selectedChangeSource: null,
    }));
  }

  private initialGraphSelection(nextSnapshot: RepositorySnapshot) {
    if (nextSnapshot.status.changedFiles.length) {
      return { type: "changes" } as const;
    }

    return nextSnapshot.commits[0]
      ? ({ type: "commit", commit: nextSnapshot.commits[0] } as const)
      : null;
  }

  private reconcileSelection(
    currentSelection: { type: "changes" } | { type: "commit"; commit: CommitInfo } | null,
    nextSnapshot: RepositorySnapshot,
  ) {
    if (currentSelection?.type === "commit") {
      const matchingCommit = nextSnapshot.commits.find(
        (commit) => commit.hash === currentSelection.commit.hash,
      );

      if (matchingCommit) {
        return { type: "commit", commit: matchingCommit } as const;
      }
    }

    if (currentSelection?.type === "changes" && nextSnapshot.status.changedFiles.length) {
      return { type: "changes" } as const;
    }

    return this.initialGraphSelection(nextSnapshot);
  }

  /* ---------------------------------------------------------------------- */
  /* Graph visibility and scrolling                                          */
  /* ---------------------------------------------------------------------- */

  toggleGraphRefs(refs: CommitRef[], visible: boolean): void {
    const nextHidden = new Set(this.hiddenGraphRefKeys);
    const currentBranch = this.snapshot?.status.currentBranch;

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

    this.hiddenGraphRefKeys = nextHidden;
    persistHiddenGraphRefKeys(this.sidebarStateKey, nextHidden);
  }

  rememberGraphScrollTop(repositoryId: string, scrollTop: number): void {
    this.graphScrollPositions.set(repositoryId, scrollTop);
  }

  graphScrollTopFor(repositoryId: string): number {
    return this.graphScrollPositions.get(repositoryId) ?? 0;
  }

  finishScrollToCommit(commandId: number): void {
    if (this.scrollToCommit?.id === commandId) {
      this.scrollToCommit = null;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Prefetching                                                             */
  /* ---------------------------------------------------------------------- */

  private prunePrefetchState(repos: WorkspaceRepo[]): void {
    const openRepoIds = new Set(repos.map((repo) => repo.id));

    for (const repoId of this.prefetchedInitialCommits.keys()) {
      if (!openRepoIds.has(repoId)) {
        this.prefetchedInitialCommits.delete(repoId);
      }
    }

  }

  private prefetchInitialCommitFiles(repos: WorkspaceRepo[]): void {
    for (const repo of repos) {
      if (!repo.snapshot || !this.workspace) {
        continue;
      }

      const commitHashes = repo.snapshot.commits
        .slice(0, initialPrefetchCommitCount)
        .map((commit) => commit.hash);

      if (!commitHashes.length) {
        continue;
      }

      const signature = commitHashes.join(":");

      if (this.prefetchedInitialCommits.get(repo.id) === signature) {
        continue;
      }

      this.prefetchedInitialCommits.set(repo.id, signature);
      void this.workspace.prefetchCommitFiles(repo.id, commitHashes).catch(() => {
        this.prefetchedInitialCommits.delete(repo.id);
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Git actions                                                             */
  /* ---------------------------------------------------------------------- */

  private requestGitAction(request: GitActionRequest, queueWhenBusy = false): void {
    const repositoryId = this.activeRepositoryId;
    if (!repositoryId || !this.client || !this.workspace) {
      return;
    }

    if (this.gitAction !== null) {
      if (queueWhenBusy) {
        this.queuedGitActions = [...this.queuedGitActions, { ...request, repositoryId }];
      }
      return;
    }

    void this.runGitAction({ ...request, repositoryId });
  }

  private async runGitAction(request: PendingGitAction): Promise<void> {
    const workspace = this.workspace;
    if (!workspace) {
      return;
    }

    this.gitAction = {
      repositoryId: request.repositoryId,
      kind: request.kind,
      label: request.label,
    };

    let applied = false;
    try {
      const mutationResult = await request.action(request.repositoryId);
      applied = true;
      if (request.affectedPaths?.length) workspace.invalidateFileContent(request.repositoryId, request.affectedPaths);
      request.onApplied?.();
      const refreshedState = await this.refreshAfterMutation(workspace, request.repositoryId, request.kind, mutationResult);
      if (request.kind === "switchBranch" && this.hasUnmergedFiles(request.repositoryId, refreshedState)) {
        toast.warning("Switched with conflicts", { description: "Resolve the highlighted conflicts." });
      } else if (request.notifySuccess !== false && request.successMessage) {
        toast.success(request.successMessage);
      }
    } catch (caught) {
      const details = typeof caught === "object" && caught && "details" in caught ? caught.details : null;
      const serverApplied =
        typeof details === "object" &&
        details &&
        "mutationSucceeded" in details &&
        details.mutationSucceeded === true;
      if (applied || serverApplied) {
        if (!applied) {
          if (request.affectedPaths?.length) workspace.invalidateFileContent(request.repositoryId, request.affectedPaths);
          request.onApplied?.();
        }
        toast.warning("Changes applied; refresh failed", {
          description: summarizeGitError(caught),
          action: {
            label: "Retry refresh",
            onClick: () => {
              void this.refreshAfterMutation(workspace, request.repositoryId, request.kind).catch((error) =>
                toast.error("Refresh failed", { description: summarizeGitError(error) }),
              );
            },
          },
        });
      } else {
        await workspace.refreshRepository(request.repositoryId).catch(() => undefined);
        toast.error(`${request.label} failed`, { description: summarizeGitError(caught) });
      }
    } finally {
      this.gitAction = null;
      const nextAction = this.queuedGitActions[0];
      this.queuedGitActions = this.queuedGitActions.slice(1);
      if (nextAction) {
        void this.runGitAction(nextAction);
      }
    }
  }

  private async refreshAfterMutation(
    workspace: ClientWorkspace,
    repositoryId: string,
    kind?: string,
    mutationResult?: unknown,
  ): Promise<ClientWorkspaceState> {
    const state = isMutationSnapshotResult(mutationResult)
      ? await workspace.applyMutationSnapshot(repositoryId, mutationResult.repository, mutationResult.snapshot)
      : kind === "stage" || kind === "unstage" || kind === "discard"
        ? await workspace.refreshRepositoryStatus(repositoryId)
        : await workspace.refreshRepository(repositoryId);
    const repository = state.repositories[repositoryId];
    if (repository?.error) throw new Error(repository.error.message);
    return state;
  }

  private hasUnmergedFiles(repositoryId: string, state: ClientWorkspaceState): boolean {
    const snapshot = state.repositories[repositoryId]?.snapshot;
    return (
      snapshot?.status.changedFiles.some(
        (file) => file.indexStatus.includes("U") || file.worktreeStatus.includes("U"),
      ) ?? false
    );
  }

  changeCommitDraft(draft: WorkingTreeDraftState): void {
    if (this.sidebarStateKey) this.commitDrafts[this.sidebarStateKey] = draft;
  }

  toggleAmend(enabled: boolean): void {
    const key = this.sidebarStateKey;
    if (!key) return;
    const draft = this.commitDrafts[key] ?? emptyDraft();
    if (!enabled) {
      this.commitDrafts[key] = { ...draft, amendMode: false };
      return;
    }
    if (!this.amendInfo?.headOid || this.amendInfo.blockedReason || this.amendLoading) return;
    this.commitDrafts[key] = {
      ...draft,
      amendMode: true,
      amendHead: this.amendInfo.headOid,
      amend:
        draft.amendHead === this.amendInfo.headOid
          ? draft.amend
          : { summary: this.amendInfo.summary, description: this.amendInfo.description },
    };
  }

  switchBranch(branchName: string): void {
    if (!this.activeRepositoryId || !this.client || this.gitActionPending) {
      return;
    }

    this.requestGitAction({
      kind: "switchBranch",
      label: `Switching to ${branchName}`,
      successMessage: `Switched to ${branchName}`,
      action: (repositoryId) =>
        this.client!.switchBranch({
          repositoryId,
          name: branchName,
          merge: readBranchSwitchMergePreference(),
        }),
    });
  }

  fetchRepository(): void {
    this.requestGitAction({
      kind: "fetch",
      label: "Fetching",
      successMessage: "Fetched from remote",
      action: (repositoryId) => this.client!.fetch(repositoryId),
    });
  }

  pullRepository(): void {
    this.requestGitAction({
      kind: "pull",
      label: "Pulling",
      successMessage: "Pulled from remote",
      action: (repositoryId) => this.client!.pull(repositoryId),
    });
  }

  pushRepository(): void {
    this.requestGitAction({
      kind: "push",
      label: "Pushing",
      successMessage: "Pushed to remote",
      action: (repositoryId) => this.client!.push(repositoryId),
    });
  }

  stageFile(file: ChangedFile): void {
    this.requestGitAction(
      {
        kind: "stage",
        label: "Staging",
        notifySuccess: false,
        affectedPaths: [file.path],
        action: (repositoryId) => this.client!.stage(repositoryId, [file.path]),
      },
      true,
    );
  }

  stagePaths(paths: string[]): void {
    if (!paths.length) {
      return;
    }

    this.requestGitAction(
      {
        kind: "stage",
        label: "Staging",
        notifySuccess: false,
        affectedPaths: paths,
        action: (repositoryId) => this.client!.stage(repositoryId, paths),
      },
      true,
    );
  }

  unstageFile(file: ChangedFile): void {
    this.requestGitAction(
      {
        kind: "unstage",
        label: "Unstaging",
        notifySuccess: false,
        affectedPaths: [file.path],
        action: (repositoryId) => this.client!.unstage(repositoryId, [file.path]),
      },
      true,
    );
  }

  unstagePaths(paths: string[]): void {
    if (!paths.length) {
      return;
    }

    this.requestGitAction(
      {
        kind: "unstage",
        label: "Unstaging",
        notifySuccess: false,
        affectedPaths: paths,
        action: (repositoryId) => this.client!.unstage(repositoryId, paths),
      },
      true,
    );
  }

  stageAll(): void {
    this.requestGitAction(
      {
        kind: "stage",
        label: "Staging",
        notifySuccess: false,
        action: (repositoryId) => this.client!.stage(repositoryId),
      },
      true,
    );
  }

  unstageAll(): void {
    this.requestGitAction(
      {
        kind: "unstage",
        label: "Unstaging",
        notifySuccess: false,
        action: (repositoryId) => this.client!.unstage(repositoryId),
      },
      true,
    );
  }

  commitChanges(draft: CommitMessageDraft): void {
    const client = this.client;
    const key = this.sidebarStateKey;
    if (!client || !key) return;
    this.requestGitAction({
      kind: draft.amend ? "amend" : "commit",
      label: draft.amend ? "Amending" : "Committing",
      successMessage: draft.amend ? "Last commit amended" : "Changes committed",
      action: (repositoryId) =>
        draft.amend
          ? client.amend({
              repositoryId,
              expectedHead: draft.expectedHead ?? "",
              summary: draft.summary,
              ...(draft.description ? { description: draft.description } : {}),
            })
          : client.commit({
              repositoryId,
              summary: draft.summary,
              ...(draft.description ? { description: draft.description } : {}),
            }),
      onApplied: () => {
        const state = this.commitDrafts[key] ?? emptyDraft();
        this.commitDrafts[key] = draft.amend
          ? { ...state, amendMode: false, amendHead: null, amend: { summary: "", description: "" } }
          : { ...state, normal: { summary: "", description: "" } };
      },
    });
  }

  async openDiscard(paths: string[]): Promise<void> {
    const client = this.client;
    const repositoryId = this.activeRepositoryId;
    const environmentId = this.workspaceState?.environmentId;
    if (!client || !repositoryId || !environmentId || this.gitActionPending || !paths.length) return;
    const dialog = { repositoryId, environmentId, client, files: [] as GitDiscardFile[], loading: true, error: "" };
    this.discardDialog = dialog;
    try {
      const files = await client.previewDiscard(repositoryId, paths);
      if (this.discardDialog?.repositoryId === repositoryId && this.discardDialog.environmentId === environmentId) {
        this.discardDialog = { ...dialog, files, loading: false };
      }
    } catch (caught) {
      if (this.discardDialog?.repositoryId === repositoryId && this.discardDialog.environmentId === environmentId) {
        this.discardDialog = { ...dialog, loading: false, error: summarizeGitError(caught) };
      }
    }
  }

  confirmDiscard(files: GitDiscardFile[], deleteUntracked: boolean): void {
    const dialog = this.discardDialog;
    if (!dialog || this.gitActionPending || !files.length) return;
    this.discardDialog = { ...dialog, loading: true, error: "" };
    this.requestGitAction({
      kind: "discard",
      label: "Discarding",
      notifySuccess: false,
      action: async (repositoryId) => {
        try {
          const outcome = await dialog.client.discard({ repositoryId, files, deleteUntracked });
          this.discardDialog = null;
          if (outcome.error) {
            toast.error("Discard stopped", {
              description: `${outcome.error}\nChanged: ${outcome.completedPaths.join(", ") || "none"}\nRemaining: ${outcome.remainingPaths.join(", ")}`,
            });
          } else {
            toast.success(`Discarded changes in ${outcome.completedPaths.length} files`);
          }
        } catch (caught) {
          if (
            this.discardDialog?.repositoryId === repositoryId &&
            this.discardDialog.environmentId === dialog.environmentId
          ) {
            this.discardDialog = {
              ...dialog,
              loading: false,
              error: `${summarizeGitError(caught)} Close this dialog and review the updated changes.`,
            };
          }
          throw caught;
        }
      },
    });
  }

  applySelectedHunks(params: GitApplyHunksParams): void {
    const client = this.client;
    if (!client || this.gitActionPending) return;
    this.requestGitAction({
      kind: params.staged ? "unstage" : "stage",
      label: params.staged ? "Unstaging hunks" : "Staging hunks",
      notifySuccess: false,
      affectedPaths: [params.filePath],
      action: () => client.applyHunks(params),
    });
  }

  openBranchDialog(): void {
    if (!this.activeRepositoryId || !this.client || this.gitActionPending) {
      return;
    }

    this.gitNameDialogValue = "";
    this.gitNameDialogError = "";
    this.gitNameDialogKind = "branch";
  }

  openStashDialog(): void {
    if (!this.activeRepositoryId || !this.client || this.gitActionPending) {
      return;
    }

    this.gitNameDialogValue = "";
    this.gitNameDialogError = "";
    this.gitNameDialogKind = "stash";
  }

  closeGitNameDialog(): void {
    if (!this.gitActionPending) {
      this.gitNameDialogKind = null;
      this.gitNameDialogValue = "";
      this.gitNameDialogError = "";
    }
  }

  submitGitNameDialog(): void {
    const name = this.gitNameDialogValue.trim();
    if (!this.gitNameDialogKind) {
      return;
    }

    if (this.gitNameDialogKind === "branch") {
      if (!name) {
        this.gitNameDialogError = "Enter a branch name to continue.";
        return;
      }

      this.closeGitNameDialog();
      this.requestGitAction({
        kind: "createBranch",
        label: "Creating branch",
        successMessage: `Created and switched to ${name}`,
        action: (repositoryId) => this.client!.createBranch({ repositoryId, name, checkout: true }),
      });
      return;
    }

    this.closeGitNameDialog();
    this.requestGitAction({
      kind: "stash",
      label: "Stashing",
      successMessage: "Changes stashed",
      action: (repositoryId) =>
        this.client!.stashPush({
          repositoryId,
          message: name || undefined,
          includeUntracked: true,
        }),
    });
  }

  popStash(): void {
    this.requestGitAction({
      kind: "stashPop",
      label: "Popping stash",
      successMessage: "Stash applied",
      action: (repositoryId) => this.client!.stashPop(repositoryId),
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Layout                                                                  */
  /* ---------------------------------------------------------------------- */

  private restoreLayout(): void {
    const stored = readLayoutPreferences();

    if (typeof stored.sidebarWidth === "number") {
      this.sidebarWidth = clamp(stored.sidebarWidth, sidebarLimits.min, sidebarLimits.max);
    }

    if (typeof stored.detailsWidth === "number") {
      this.detailsWidth = clamp(stored.detailsWidth, detailsLimits.min, detailsLimits.max);
    }
  }

  resizePane(id: string, width: number): void {
    if (id === "sidebar") {
      this.sidebarWidth = clamp(width, sidebarLimits.min, sidebarLimits.max);
    }

    if (id === "details") {
      this.detailsWidth = clamp(width, detailsLimits.min, detailsLimits.max);
    }

    persistLayoutPreferences({
      sidebarWidth: this.sidebarWidth,
      detailsWidth: this.detailsWidth,
    });
  }
}

function isMutationSnapshotResult(
  value: unknown,
): value is { repository: RepositorySummary; snapshot: RepositorySnapshot } {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Partial<{ repository: RepositorySummary; snapshot: RepositorySnapshot }>;
  return Boolean(result.repository && result.snapshot);
}
