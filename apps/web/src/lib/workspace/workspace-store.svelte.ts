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
import { beforeNavigate, goto } from "$app/navigation";
import { page } from "$app/state";
import { browser } from "$app/environment";
import { toast } from "svelte-sonner";
import { untrack } from "svelte";
import type { GitGuiClient } from "@gitgui/client-runtime";
import { sameRepository, scopedRepositoryKey, type RepositoryTabs, type ScopedRepositoryRef } from "@gitgui/client-runtime/workspace";
import { ApplicationWorkspace, sameHostPath } from "$lib/client-runtime/application-workspace";
import { displayHostPath } from "$lib/display-host-path";
import type {
  ChangedFile,
  GitAmendInfo,
  GitApplyHunksParams,
  GitDiscardFile,
  GitDiscardResult,
  GitWorktreeRemoveResult,
  RepositorySummary,
  GitTagDetails,
  GitFetchResult,
  GitPushResult,
  GitIntegrationState, GitIntegrationReview, GitIntegrationAction, GitIntegrationRecovery, GitIntegrationOutcome,
  GitRewritePushReview,
} from "@gitgui/contracts";
import { type ClientWorkspace, type ClientWorkspaceState } from "$lib/client-runtime";
import { readDesktopBridge } from "$lib/connection/platform";
import type { WebApplicationRuntime, WebApplicationRuntimeState } from "$lib/connection/runtime";
import type { EnvironmentEntryView, EnvironmentRepositoryCatalogView } from "$lib/connection/runtime";
import type { EnvironmentWorkspaceView } from "$lib/connection/environment-workspace";
import type { RepositoryGroup, ScopedRepositorySummary } from "@gitgui/client-runtime/workspace";
import type { GroupedRepository } from "$lib/components/GroupedRepositoriesHome.svelte";
import { repositoryLocations } from "$lib/components/repository-locations";
import { repositoryManagementAvailability, type RepositoryManagementAction } from "$lib/connection/repository-availability";
import { readBranchSwitchMergePreference, resolveProjectsLocation } from "$lib/preferences";
import { graphRefKey, isCurrentBranchRef } from "$lib/types/branch-visibility";
import { tagName, tagNameError } from "$lib/types/tags";
import { graphTargets } from "$lib/git-graph/targets";
import { parseTagConflicts, type TagFetchReview } from "./tag-sync";
import type { CommitFile, CommitInfo, CommitRef, RepositorySnapshot, StashInfo, WorktreeInfo } from "$lib/types/repository";
import { removableWorktree } from "./worktree-menu";
import { captureStashActionContext, reconcileSelectedStash } from "./stash-selection";
import { reconcileRepositorySelection } from "./repository-selection";
import { performStashOperation, selectedStashPaths, stashContextIsCurrent, stashMethods, type StashAction, type StashDialog, type StashReceipt } from "./stash-operations";
import type { RepoTab } from "$lib/components/TopMenu.svelte";
import type { ResizablePane } from "$lib/components/ResizablePaneGroup.svelte";
import type {
  CommitMessageDraft,
  WorkingTreeDiffSource,
  WorkingTreeDraftState,
} from "$lib/components/WorkingTreePanel.svelte";
import { formatError, isConnectionError, summarizeGitError } from "./errors";
import { discardFailureNotice, validateDiscardReceipt } from "./discard-operations";
import {
  persistHiddenGraphRefKeys,
  persistLayoutPreferences,
  readHiddenGraphRefKeys,
  readLayoutPreferences,
} from "./preferences";
import { HOME_ROUTE_ID, repositoryIdFromParam, repositoryPath, scopedRepositoryPath } from "./routes";
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
  integrationState = $state<GitIntegrationState | null>(null);
  integrationReview = $state<{ repositoryId: string; environmentId: string; review: GitIntegrationReview; action: GitIntegrationAction } | null>(null);
  integrationError = $state("");
  integrationRecoveryDialog = $state<{ repositoryId: string; environmentId: string; kind: GitIntegrationState["kind"]; action: "abort" | "skip" } | null>(null);
  rewritePushReview = $state<{ repositoryId: string; environmentId: string; review: GitRewritePushReview } | null>(null);
  rewritePushReviewPending = $state(false);
  private integrationReadSequence = 0;
  private integrationScopeKey: string | null = null;
  get canIntegrate(): boolean { return !this.gitActionPending && (this.client?.serverWelcome.capabilities.includes("git.integration.start") ?? false); }
  get canStartIntegration(): boolean { return this.canIntegrate && Boolean(this.snapshot?.status.currentBranch && this.snapshot?.status.headOid); }
  get canRebaseCommit(): boolean { return this.canStartIntegration && (this.client?.serverWelcome.capabilities.includes("git.integration.commit_target") ?? false); }

  async refreshIntegration(): Promise<void> {
    const client = this.client, repositoryId = this.activeRepositoryId, environmentId = this.workspaceState?.environmentId;
    const sequence = ++this.integrationReadSequence;
    if (this.integrationReview && (this.integrationReview.repositoryId !== repositoryId || this.integrationReview.environmentId !== environmentId)) this.integrationReview = null;
    if (this.rewritePushReview && (this.rewritePushReview.repositoryId !== repositoryId || this.rewritePushReview.environmentId !== environmentId)) this.rewritePushReview = null;
    const scopeKey = repositoryId && environmentId ? JSON.stringify([environmentId, repositoryId]) : null;
    if (scopeKey !== this.integrationScopeKey) {
      this.integrationScopeKey = scopeKey;
      this.integrationState = null;
      this.integrationRecoveryDialog = null;
    }
    this.integrationError = "Checking Git operation state…";
    if (!client || !repositoryId || !environmentId || !client.serverWelcome.capabilities.includes("git.integration.inspect")) {
      this.integrationState = null; this.integrationError = ""; return;
    }
    try {
      const state = await client.inspectIntegration(repositoryId);
      if (sequence === this.integrationReadSequence && this.client === client && this.activeRepositoryId === repositoryId && this.workspaceState?.environmentId === environmentId) {
        this.integrationState = state;
        if (this.integrationRecoveryDialog && this.integrationRecoveryDialog.kind !== state?.kind) this.integrationRecoveryDialog = null;
        this.integrationError = "";
      }
    } catch (error) {
      if (sequence === this.integrationReadSequence) {
        this.integrationState = null;
        this.integrationRecoveryDialog = null;
        this.integrationError = summarizeGitError(error);
      }
    }
  }

  async openIntegrationReview(targetRef: string, action: GitIntegrationAction): Promise<void> {
    const client = this.client, repositoryId = this.activeRepositoryId, environmentId = this.workspaceState?.environmentId;
    if (!client || !repositoryId || !environmentId || !this.canStartIntegration || (action === "rebase" && !this.canRebaseCommit) || this.integrationError || this.integrationState) return;
    try {
      const review = await client.reviewIntegration({ repositoryId, targetRef });
      if (this.client === client && this.activeRepositoryId === repositoryId && this.workspaceState?.environmentId === environmentId) {
        if (action === "rebase") {
          if (!this.canStartIntegration || this.integrationError || this.integrationState) return;
          this.startReviewedIntegration(review, action);
        } else {
          this.integrationReview = { repositoryId, environmentId, review, action };
        }
      }
    } catch (error) { toast.error("Could not review operation", { description: summarizeGitError(error) }); }
  }

  confirmIntegration(): void {
    const pending = this.integrationReview;
    if (!pending || pending.repositoryId !== this.activeRepositoryId || pending.environmentId !== this.workspaceState?.environmentId || !this.canIntegrate) return;
    // The runtime snapshots RPC inputs with structuredClone; Svelte's nested
    // state proxies must be converted to plain data before crossing that boundary.
    const review = { ...pending.review };
    const action = pending.action;
    this.integrationReview = null;
    this.startReviewedIntegration(review, action);
  }

  private startReviewedIntegration(review: GitIntegrationReview, action: GitIntegrationAction): void {
    const inputReview = { ...review };
    this.requestGitAction({ kind: "integration", label: action === "merge" ? "Merging" : "Rebasing",
      action: (repositoryId, client) => client.startIntegration({ repositoryId, review: inputReview, action }),
      onApplied: () => { void this.refreshIntegration(); },
      onSucceeded: (value) => this.handleIntegrationOutcome(value as GitIntegrationOutcome),
      onFailed: () => { void this.refreshIntegration(); return false; },
    });
  }

  recoverIntegration(action: GitIntegrationRecovery): void {
    const state = this.integrationState;
    if (!state || state.kind === "unknown" || !this.canIntegrate) return;
    this.requestGitAction({ kind: "integration", label: `${action} ${state.kind}`,
      action: (repositoryId, client) => client.recoverIntegration({ repositoryId, kind: state.kind, action }),
      onApplied: () => { void this.refreshIntegration(); },
      onSucceeded: (value) => this.handleIntegrationOutcome(value as GitIntegrationOutcome),
      onFailed: () => { void this.refreshIntegration(); return false; },
    });
  }

  requestIntegrationRecovery(action: GitIntegrationRecovery): void {
    const state = this.integrationState, repositoryId = this.activeRepositoryId, environmentId = this.workspaceState?.environmentId;
    if (!state || state.kind === "unknown" || !repositoryId || !environmentId || !this.canIntegrate || this.integrationError) return;
    if (action === "continue") { if (!state.unresolvedPaths.length) this.recoverIntegration(action); return; }
    if (action === "skip" && state.kind !== "rebase") return;
    this.integrationRecoveryDialog = { repositoryId, environmentId, kind: state.kind, action };
  }

  confirmIntegrationRecovery(): void {
    const dialog = this.integrationRecoveryDialog;
    if (!dialog) return;
    if (dialog.repositoryId !== this.activeRepositoryId || dialog.environmentId !== this.workspaceState?.environmentId || dialog.kind !== this.integrationState?.kind) {
      this.integrationRecoveryDialog = null;
      return;
    }
    if (this.integrationError || !this.canIntegrate) return;
    this.integrationRecoveryDialog = null;
    this.recoverIntegration(dialog.action);
  }

  private handleIntegrationOutcome(outcome: GitIntegrationOutcome): void {
    void this.refreshIntegration();
    if (outcome.failure && outcome.state?.unresolvedPaths.length) toast.warning("Git stopped for conflicts", { description: "Resolve and stage the conflicted files, then continue." });
    else if (outcome.failure) toast.error("Git operation stopped", { description: outcome.failure.stderr || outcome.failure.message });
    else if (outcome.state) toast.warning("Git operation is still in progress");
    else toast.success("Git operation completed");
  }

  async openRewritePushReview(): Promise<void> {
    const client = this.client, repositoryId = this.activeRepositoryId, environmentId = this.workspaceState?.environmentId;
    if (!client || !repositoryId || !environmentId || !this.canIntegrate || this.integrationState || this.integrationError || this.rewritePushReviewPending || !client.serverWelcome.capabilities.includes("git.rewrite_push.execute")) return;
    this.rewritePushReviewPending = true;
    try {
      const review = await client.reviewRewritePush(repositoryId);
      if (this.client === client && this.activeRepositoryId === repositoryId && this.workspaceState?.environmentId === environmentId) this.rewritePushReview = { repositoryId, environmentId, review };
    } catch (error) { toast.error("Could not review push", { description: summarizeGitError(error) }); }
    finally { this.rewritePushReviewPending = false; }
  }

  confirmRewritePush(): void {
    const pending = this.rewritePushReview;
    if (!pending || pending.repositoryId !== this.activeRepositoryId || pending.environmentId !== this.workspaceState?.environmentId || !this.canIntegrate) return;
    const pushReview = { ...pending.review };
    this.rewritePushReview = null;
    this.requestGitAction({ kind: "push", label: "Pushing rewritten branch", successMessage: "Pushed rewritten branch",
      action: (repositoryId, client) => client.pushRewrite({ repositoryId, pushReview }),
    });
  }
  tagFetchReview = $state<TagFetchReview | null>(null);
  private readonly tagDetailsCache = new Map<string, Promise<GitTagDetails>>();
  private tagDetailsEnvironment: string | null = null;
  /* ---------------------------------------------------------------------- */
  /* Connection runtime projection                                            */
  /* ---------------------------------------------------------------------- */

  readonly isDesktop: boolean = false;
  private externalTabs = false;
  get usesApplicationTabs(): boolean { return this.externalTabs; }

  client = $state<GitGuiClient | null>(null);
  workspace = $state<ClientWorkspace | null>(null);
  workspaceState = $state<ClientWorkspaceState | null>(null);
  bootstrapping = $state(false);
  connectionError = $state(false);
  startError = $state("");
  operationPending = $state(false);
  repositoryPathPending = $state(false);
  private pendingCreateEnvironments = $state<Record<string, boolean>>({});
  applicationReady = $state(false);
  private connectionEnvironmentId = $state<string | null>(null);

  /* ---------------------------------------------------------------------- */
  /* Repositories                                                            */
  /* ---------------------------------------------------------------------- */

  repositoryCatalog = $state<RepositorySummary[]>([]);
  applicationTabs = $state<RepositoryTabs>({ tabs: [], activeTabId: null });
  environmentViews = $state<Readonly<Record<string, EnvironmentWorkspaceView>>>({});
  environmentEntries = $state<readonly EnvironmentEntryView[]>([]);
  environmentCatalogs = $state<Readonly<Record<string, EnvironmentRepositoryCatalogView>>>({});
  repositoryGroups = $state<readonly RepositoryGroup<ScopedRepositorySummary>[]>([]);
  openRepos = $state<WorkspaceRepo[]>([]);
  activeRepositoryId = $state<string | null>(null);
  stashContextKey = $derived(this.connectionEnvironmentId && this.activeRepositoryId ? `${this.connectionEnvironmentId}:${this.activeRepositoryId}` : null);

  /* ---------------------------------------------------------------------- */
  /* Git actions                                                             */
  /* ---------------------------------------------------------------------- */

  private pendingGitActions = $state.raw<Record<string, { environmentId: string; repositoryId: string; kind: string; label: string }>>({});
  gitAction = $derived(this.connectionEnvironmentId && this.activeRepositoryId
    ? this.pendingGitActions[scopedRepositoryKey({ environmentId: this.connectionEnvironmentId, repositoryId: this.activeRepositoryId })] ?? null : null);
  // Entries retain their captured client/workspace and drain independently by checkout.
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
    workspace: ClientWorkspace;
  } | null>(null);
  private discardPreviewGeneration = 0;
  private discardActionGeneration = 0;
  repositoryPathDialogOpen = $state(false);
  repositoryPathEnvironmentId = $state<string | null>(null);
  stashReview = $state<StashDialog | null>(null);
  repositoryPathValue = $state("");
  repositoryPathError = $state("");
  gitNameDialogKind = $state<"branch" | "renameBranch" | "tag" | "stash" | null>(null);
  gitNameDialogValue = $state("");
  gitNameDialogError = $state("");
  gitNameDialogCheckout = $state(true);
  gitNameDialogContext = $state<{
    repositoryId: string;
    environmentId: string;
    startPoint?: string;
    branch?: CommitRef;
  } | null>(null);
  deleteBranchDialog = $state<{
    repositoryId: string;
    environmentId: string;
    branch: CommitRef;
    force: boolean;
    error: string;
  } | null>(null);
  deleteTagDialog = $state<{
    repositoryId: string;
    environmentId: string;
    tag: CommitRef;
    error: string;
  } | null>(null);
  removeWorktreeDialog = $state<{
    repositoryId: string;
    environmentId: string;
    worktree: WorktreeInfo;
    deleteBranch: boolean;
    forceBranchDeletion: boolean;
    error: string;
  } | null>(null);

  /* ---------------------------------------------------------------------- */
  /* Create repository                                                       */
  /* ---------------------------------------------------------------------- */

  createRepositoryParentPath = $state("");
  createRepositoryEnvironmentId = $state<string | null>(null);
  createRepositoryPending = $derived(Boolean(this.createRepositoryEnvironmentId && this.pendingCreateEnvironments[this.createRepositoryEnvironmentId]));
  createRepositoryName = $state("");
  createRepositoryInitialBranch = $state("");
  createRepositoryInitializeLfs = $state(false);
  createRepositoryError = $state("");
  /** True once the create form has been filled with its defaults. */
  createRepositoryPrepared = $state(false);
  createRepositoryPreparing = $state(false);

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
  repositoryDisconnected = $derived(this.externalTabs && Boolean(this.connectionEnvironmentId) &&
    this.environmentEntries.find((entry) => entry.registration.environmentId === this.connectionEnvironmentId)?.connection.phase !== "connected");
  activeEnvironmentGeneration = $derived.by(() => {
    const view = this.connectionEnvironmentId ? this.environmentViews[this.connectionEnvironmentId] : undefined;
    // Invalidate on loss, then revalidate once replacement capabilities are installed.
    // The stable client briefly carries an offline welcome during activation.
    return view?.welcome ? view.generation : 0;
  });
  repositoryAvailability = $derived.by(() => {
    const id = this.connectionEnvironmentId;
    const entry = this.environmentEntries.find((item) => item.registration.environmentId === id);
    const view = id ? this.environmentViews[id] : undefined;
    const phase = entry?.connection.phase;
    const environmentLabel = entry?.registration.displayName ?? id ?? "Environment";
    const failure = this.activeRepository?.error || view?.error || entry?.connection.lastFailure?.detail;
    if (phase === "offline") return { environmentLabel, title: "Environment offline", detail: failure || "Reconnect to load this repository.", canRetry: true };
    if (phase === "backoff") return {
      environmentLabel, title: "Reconnecting to environment", detail: failure || "The connection will retry automatically.", canRetry: true,
    };
    if (phase === "blocked" || phase === "available" || !entry) return {
      environmentLabel, title: "Environment unavailable", detail: failure || "Connect to this environment to load the repository.", canRetry: Boolean(entry),
    };
    // A restored placeholder has no snapshot until connection and hydration finish.
    if (view?.loading || this.activeRepository?.loading || phase !== "connected") return {
      environmentLabel, title: "Loading repository…", detail: "Waiting for the environment and repository snapshot.", canRetry: false,
    };
    return failure
      ? { environmentLabel, title: "Repository unavailable", detail: failure, canRetry: true }
      : { environmentLabel, title: "Loading repository…", detail: "Waiting for the repository snapshot.", canRetry: false };
  });
  private graphSourceRefs = $derived(this.snapshot?.refs ?? []);
  private graphSourceCommits = $derived(this.snapshot?.commits ?? []);
  private graphCurrentBranch = $derived(this.snapshot?.status.currentBranch);
  private graphHeadOid = $derived(this.snapshot?.status.headOid);
  repositoryCanOperate = $derived(!this.externalTabs || Boolean(this.connectionEnvironmentId && this.environmentViews[this.connectionEnvironmentId]?.sessionScopes?.includes("repository:operate")));
  gitActionPending = $derived(this.gitAction !== null || this.repositoryDisconnected || !this.repositoryCanOperate);
  canRenameBranch = $derived(!this.gitActionPending && (this.client?.serverWelcome.capabilities.includes("git.branch.rename") ?? false));
  canDeleteBranch = $derived(!this.gitActionPending && (this.client?.serverWelcome.capabilities.includes("git.branch.delete") ?? false));
  canCreateTag = $derived(!this.gitActionPending && (this.client?.serverWelcome.capabilities.includes("git.tag.create") ?? false));
  canDeleteTag = $derived(!this.gitActionPending && (this.client?.serverWelcome.capabilities.includes("git.tag.delete") ?? false));
  canCheckoutTag = $derived(!this.gitActionPending && (this.client?.serverWelcome.capabilities.includes("git.tag.checkout") ?? false));
  canPushTag = $derived(!this.gitActionPending && (this.client?.serverWelcome.capabilities.includes("git.tag.push") ?? false));
  canRemoveWorktree = $derived(!this.gitActionPending && (this.client?.serverWelcome.capabilities.includes("git.worktree.remove") ?? false));
  stashCapabilities = $derived({
    selected: this.supportsStash("selected"), apply: this.supportsStash("apply"),
    pop: this.supportsStash("pop"), drop: this.supportsStash("drop"), branch: this.supportsStash("branch"),
  });
  canPopStash = $derived(this.stashCapabilities.pop && Boolean(this.snapshot?.stashes.length));
  activeWorkingTreeAction = $derived(
    this.gitAction?.repositoryId === this.activeRepositoryId && this.gitAction.environmentId === this.connectionEnvironmentId ? this.gitAction : null,
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
        action.repositoryId === this.activeRepositoryId && action.environmentId === this.connectionEnvironmentId &&
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
    this.graphSourceRefs.filter(
      (ref) =>
        isCurrentBranchRef(ref, this.graphCurrentBranch) ||
        !this.hiddenGraphRefKeys.has(graphRefKey(ref)),
    ),
  );
  visibleGraphRefKeys = $derived(new Set(this.visibleGraphRefs.map((ref) => graphRefKey(ref))));
  graphHasHiddenRefs = $derived(
    this.graphSourceRefs.some((ref) =>
      !isCurrentBranchRef(ref, this.graphCurrentBranch) && this.hiddenGraphRefKeys.has(graphRefKey(ref)),
    ),
  );
  graphTargetCommitHashes = $derived(this.graphHasHiddenRefs ? graphTargets(this.graphSourceCommits, [
      ...(this.graphHeadOid ? [this.graphHeadOid] : []),
      ...this.visibleGraphRefs.map((ref) => ref.target),
  ]) : []);
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
  graphSnapshot = $derived(
    !this.snapshot || !this.graphVisibilityReady
      ? null
      : {
          ...this.snapshot,
          ...(this.filteredGraphView && this.graphHasHiddenRefs && this.filteredGraphView.sourceGraph === this.snapshot.graph
            ? { commits: this.filteredGraphView.commits, graph: this.filteredGraphView.graph }
            : {}),
          // Badges update immediately while the server prepares filtered lanes.
          refs: this.graphHasHiddenRefs ? this.visibleGraphRefs : this.snapshot.refs,
        },
  );

  selectedGraphItem = $derived(this.activeRepository?.selectedGraphItem ?? null);
  selectedFile = $derived(this.activeRepository?.selectedFile ?? null);
  selectedFileSource = $derived(this.activeRepository?.selectedFileSource ?? "workingTree");
  private comparisonHashes = $state<Record<string, string>>({});
  comparingCommitToWorkingTreeHash = $derived(this.connectionEnvironmentId && this.activeRepositoryId
    ? this.comparisonHashes[scopedRepositoryKey({ environmentId: this.connectionEnvironmentId, repositoryId: this.activeRepositoryId })] ?? null : null);
  selectedChangePaths = $derived(this.activeRepository?.selectedChangePaths ?? []);
  selectedChangeSource = $derived(this.activeRepository?.selectedChangeSource ?? "workingTree");
  selectedCommit = $derived(
    this.selectedGraphItem?.type === "commit" ? this.selectedGraphItem.commit : null,
  );
  selectedStash = $derived(
    this.selectedGraphItem?.type === "stash" ? this.selectedGraphItem.stash : null,
  );
  comparingCommitToWorkingTree = $derived(this.comparingCommitToWorkingTreeHash === this.selectedCommit?.hash);
  changesSelected = $derived(this.selectedGraphItem?.type === "changes");

  repoTabs = $derived.by<RepoTab[]>(() => {
    const tabs: RepoTab[] = this.externalTabs ? this.applicationTabs.tabs.map((tab) => {
      const view = this.environmentViews[tab.target.environmentId];
      const repository = view?.workspaceState.repositories[tab.target.repositoryId];
      const summary = repository?.repository;
      const entry = this.environmentEntries.find((item) => item.registration.environmentId === tab.target.environmentId);
      const title = summary?.name || tab.target.repositoryId;
      const branch = repository?.snapshot?.status.currentBranch;
      const label = this.isDesktop && entry?.registration.target.kind === "primary" ? "" : entry?.registration.displayName ?? tab.target.environmentId;
      return { id: tab.tabId, title, root: summary?.root || "", isWorktree: summary?.isWorktree ?? false,
        branch: [label, branch && branch !== title ? branch : ""].filter(Boolean).join(" · "), error: repository?.error?.message ?? "" };
    }) : this.openRepos.map((repo) => ({
      id: repo.id,
      title: repo.title,
      root: repo.root,
      isWorktree: repo.isWorktree,
      branch: repo.snapshot ? repo.snapshot.status.currentBranch ?? "Detached HEAD" : "",
      error: repo.error ?? "",
    }));
    return tabs.map((tab) => {
      const duplicate = tabs.some((other) => other.id !== tab.id && other.title === tab.title && other.branch === tab.branch);
      return duplicate && tab.root ? { ...tab, branch: [tab.branch, displayHostPath(tab.root)].filter(Boolean).join(" · ") } : tab;
    });
  });

  loading = $derived(
    (this.externalTabs && !this.applicationReady) || this.bootstrapping ||
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
    this.selectedFile && (this.selectedCommit || this.selectedStash || this.changesSelected)
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
      .filter((repository) => repository.isWorktree !== true || repository.missing)
      .map((repository) => ({
        repositoryId: repository.id,
        root: repository.root,
        title: this.repositoryTitle(repository),
        missing: repository.missing,
      })),
  );

  groupedHomeRepositories = $derived<GroupedRepository[]>(this.repositoryGroups.map((group) => {
    const families = new Map<string, ScopedRepositorySummary>();
    for (const member of group.members) {
      const key = JSON.stringify([member.ref.environmentId, member.worktreeFamilyKey ?? member.ref.repositoryId]);
      const previous = families.get(key);
      if (!previous || (previous.repository.isWorktree && !member.repository.isWorktree)) families.set(key, member);
    }
    return { groupId: group.key, title: group.members[0]?.repository.name || "Repository",
    locations: [...families.values()].map((member) => {
      const entry = this.environmentEntries.find((candidate) => candidate.registration.environmentId === member.ref.environmentId);
      return { target: member.ref, environmentLabel: entry?.registration.displayName ?? member.ref.environmentId,
        local: this.isDesktop && entry?.registration.target.kind === "primary",
        removeAvailability: this.repositoryActionAvailability(member.ref.environmentId, "remove"),
        environmentStatus: entry?.connection.phase, path: member.repository.root, missing: member.repository.missing };
    }),
  }; }).filter((group) => group.locations.length > 0));

  operationEnvironments = $derived(this.environmentEntries.map((entry) => ({
    id: entry.registration.environmentId, label: entry.registration.displayName,
    primary: this.isDesktop && entry.registration.target.kind === "primary",
    canOpen: this.repositoryActionAvailability(entry.registration.environmentId, "open").allowed,
    openReason: this.repositoryActionAvailability(entry.registration.environmentId, "open").reason,
    canCreate: this.repositoryActionAvailability(entry.registration.environmentId, "create").allowed,
    createReason: this.repositoryActionAvailability(entry.registration.environmentId, "create").reason,
  })));
  homeEnvironmentCatalogs = $derived(this.environmentEntries.map((entry) => {
    const id = entry.registration.environmentId;
    const catalog = this.environmentCatalogs[id];
    return {
      id, label: entry.registration.displayName,
      loading: catalog?.status === "syncing" || (!catalog?.hasSnapshot && !catalog?.error && (entry.connection.phase === "connected" || entry.connection.phase === "connecting")),
      error: catalog?.error || entry.connection.lastFailure?.detail || "",
      connectionStatus: entry.connection.phase,
    };
  }));
  createEnvironmentLabel = $derived(this.environmentEntries.find((entry) => entry.registration.environmentId === this.createRepositoryEnvironmentId)?.registration.displayName ?? "");
  selectedRepositoryActions = $derived({
    open: this.repositoryActionAvailability(this.connectionEnvironmentId, "open"),
    create: this.repositoryActionAvailability(this.connectionEnvironmentId, "create"),
    remove: this.repositoryActionAvailability(this.connectionEnvironmentId, "remove"),
  });
  createAvailability = $derived(this.repositoryActionAvailability(this.createRepositoryEnvironmentId, "create"));
  pathOpenAvailability = $derived(this.repositoryActionAvailability(this.repositoryPathEnvironmentId ?? this.connectionEnvironmentId, "open"));
  canBrowseCreateLocation = $derived(this.isDesktop && this.environmentEntries.some((entry) => entry.registration.environmentId === this.createRepositoryEnvironmentId && entry.registration.target.kind === "primary"));
  activeApplicationTab = $derived(this.applicationTabs.tabs.find((tab) => tab.tabId === this.applicationTabs.activeTabId) ?? null);
  activeRepositoryEnvironments = $derived(this.activeApplicationTab ? repositoryLocations(
    this.repositoryGroups.find((group) => group.members.some((member) => sameRepository(member.ref, this.activeApplicationTab!.target))),
    this.environmentEntries, this.activeApplicationTab.target, this.isDesktop,
  ) : []);

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  private readonly runtime: WebApplicationRuntime;
  private applicationWorkspace: ApplicationWorkspace | null = null;
  private unsubscribeApplicationWorkspace: (() => void) | null = null;
  private unsubscribeRuntime: (() => void) | null = null;
  private unsubscribeDeepLink: (() => void) | null = null;
  private appliedRuntimeWorkspace: ClientWorkspace | null = null;
  private largeScreenMediaQuery: MediaQueryList | null = null;
  private activeWorkspaceRequest = 0;
  private pendingRepositorySwitch: AbortController | null = null;
  private pendingPathRequest: AbortController | null = null;
  private createPreparation = 0;
  private amendRequest = 0;
  private amendSnapshotGraph: RepositorySnapshot["graph"] | undefined;
  private amendMetadataRevision = 0;
  private amendRefreshGeneration = $state(0);
  private nextScrollCommandId = 0;
  private graphRequestGeneration = 0;
  private lastGraphRequestKey: string | null = null;
  private lastGraphSource: RepositorySnapshot["graph"] | null = null;
  private hasResumed = false;
  private readonly graphScrollPositions = new Map<string, number>();
  private readonly prefetchedInitialCommits = new Map<string, string>();
  private readonly repositorySelections = new Map<string, WorkspaceRepo>();

  constructor(runtime: WebApplicationRuntime) {
    this.runtime = runtime;
    this.isDesktop = runtime.isDesktop;
    this.externalTabs = runtime.tabOwnership === "external";
    // Browser history and links can navigate without going through store actions.
    if (browser) beforeNavigate(() => this.cancelRepositorySwitch());

    $effect(() => {
      const client = this.client;
      const repositoryId = this.activeRepositoryId;
      // Status-only row reconciliation must not enqueue another lock-taking
      // amend review ahead of the next interactive mutation. Full snapshots and
      // unfiltered metadata observations still revalidate workflow blockers.
      this.amendRefreshGeneration;
      const currentSnapshot = untrack(() => this.snapshot);
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
      const stashReview = this.stashReview;
      if (stashReview && (stashReview.context.repositoryId !== this.activeRepositoryId || stashReview.context.environmentId !== this.workspaceState?.environmentId)) this.stashReview = null;
      const dialog = this.discardDialog;
      if (
        dialog &&
        (dialog.repositoryId !== this.activeRepositoryId ||
          dialog.environmentId !== this.workspaceState?.environmentId ||
          dialog.client !== this.client || dialog.workspace !== this.workspace)
      ) {
        this.discardDialog = null;
        this.discardPreviewGeneration += 1;
      }
      const nameContext = this.gitNameDialogContext;
      if (nameContext && (nameContext.repositoryId !== this.activeRepositoryId || nameContext.environmentId !== this.workspaceState?.environmentId)) {
        this.clearGitNameDialog();
      }
      const branchDialog = this.deleteBranchDialog;
      if (branchDialog && (branchDialog.repositoryId !== this.activeRepositoryId || branchDialog.environmentId !== this.workspaceState?.environmentId)) {
        this.deleteBranchDialog = null;
      }
      const tagDialog = this.deleteTagDialog;
      if (tagDialog && (tagDialog.repositoryId !== this.activeRepositoryId || tagDialog.environmentId !== this.workspaceState?.environmentId)) {
        this.deleteTagDialog = null;
      }
      const fetchReview = this.tagFetchReview;
      if (fetchReview && (fetchReview.repositoryId !== this.activeRepositoryId || fetchReview.environmentId !== this.workspaceState?.environmentId)) this.tagFetchReview = null;
      const detailsEnvironment = this.workspaceState?.environmentId ?? null;
      if (detailsEnvironment !== this.tagDetailsEnvironment) { this.tagDetailsCache.clear(); this.tagDetailsEnvironment = detailsEnvironment; }
      const worktreeDialog = this.removeWorktreeDialog;
      if (worktreeDialog && (worktreeDialog.repositoryId !== this.activeRepositoryId || worktreeDialog.environmentId !== this.workspaceState?.environmentId)) {
        this.removeWorktreeDialog = null;
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
    if (this.runtime.tabOwnership === "external") {
      const application = new ApplicationWorkspace(this.runtime, localStorage);
      this.applicationWorkspace = application;
      void application.start().then(() => {
        if (this.applicationWorkspace !== application) return;
        this.applicationReady = true;
        this.unsubscribeApplicationWorkspace = application.subscribe((tabs) => {
          this.applicationTabs = tabs;
          this.applyApplicationRuntimeState(this.runtime.state);
          if (!this.hasResumed && this.currentRouteId === HOME_ROUTE_ID) {
            this.hasResumed = true;
            const target = tabs.tabs.find((tab) => tab.tabId === tabs.activeTabId)?.target;
            if (target) void this.navigate(scopedRepositoryPath(target.environmentId, target.repositoryId), { replaceState: true });
          }
        });
      }).catch((error) => { this.applicationReady = true; this.startError = formatError(error); });
    }
    this.unsubscribeDeepLink = readDesktopBridge()?.onDeepLink((url) => {
      const target = resolveDeepLinkTarget(url);
      if (target) void this.navigateTo(target);
    }) ?? null;
  }

  dispose(): void {
    this.cancelRepositorySwitch();
    this.unsubscribeApplicationWorkspace?.();
    this.unsubscribeApplicationWorkspace = null;
    this.applicationWorkspace?.dispose();
    this.applicationWorkspace = null;
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
    this.cancelRepositorySwitch();
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

  private cancelRepositorySwitch(): void {
    this.pendingRepositorySwitch?.abort();
    if (this.pendingPathRequest && this.pendingPathRequest === this.pendingRepositorySwitch) {
      this.pendingPathRequest = null;
      this.repositoryPathPending = false;
      this.repositoryPathDialogOpen = false;
      this.repositoryPathError = "";
    }
    this.pendingRepositorySwitch = null;
  }

  private beginRepositorySwitch(): AbortController {
    this.cancelRepositorySwitch();
    const request = new AbortController();
    this.pendingRepositorySwitch = request;
    return request;
  }

  /* ---------------------------------------------------------------------- */
  /* Runtime state                                                           */
  /* ---------------------------------------------------------------------- */

  private applyApplicationRuntimeState(state: WebApplicationRuntimeState): void {
    this.environmentViews = state.environmentWorkspaces ?? {};
    this.environmentEntries = state.registry.entries;
    this.environmentCatalogs = state.catalogs;
    this.repositoryGroups = state.repositoryGroups ?? [];
    if (this.runtime.tabOwnership === "external") {
      const active = this.applicationTabs.tabs.find((tab) => tab.tabId === this.applicationTabs.activeTabId);
      const environmentId = active?.target.environmentId;
      const view = environmentId ? state.environmentWorkspaces?.[environmentId] : undefined;
      const connection = state.registry.entries.find((entry) => entry.registration.environmentId === environmentId)?.connection ?? null;
      state = { ...state, registry: { ...state.registry, selectedEnvironmentId: environmentId }, connection,
        client: view?.client ?? null, workspace: view?.workspace ?? null, workspaceState: view?.workspaceState ?? null,
        loading: Boolean(active && (!view || view.loading)), error: view?.error ?? "" };
    }
    if (this.discardDialog && (this.discardDialog.client !== state.client || this.discardDialog.workspace !== state.workspace)) {
      this.discardDialog = null;
      this.discardPreviewGeneration += 1;
    }
    // The legacy selected-workspace projection cannot safely retain queued
    // actions across replacement; external tab ownership will scope its queue.
    if (this.runtime.tabOwnership !== "external" && this.workspace && state.workspace && this.workspace !== state.workspace) this.queuedGitActions = [];
    this.connectionEnvironmentId = state.registry.selectedEnvironmentId ?? state.client?.serverWelcome.environment_id ?? null;
    if (this.workspaceState && this.connectionEnvironmentId !== this.workspaceState.environmentId) {
      this.stashReview = null;
      this.openRepos = this.openRepos.map((repo) => repo.selectedGraphItem?.type === "stash"
        ? { ...repo, selectedGraphItem: null, selectedFile: null, selectedFileSource: null } : repo);
    }
    // Registrations survive disconnects. Their removal is the signal to
    // release environment-owned drafts, matching the runtime's cache lifetime.
    const registeredEnvironments = new Set(
      state.registry.entries.map((entry) => entry.registration.environmentId),
    );
    if (this.externalTabs) this.queuedGitActions = this.queuedGitActions.filter((action) => registeredEnvironments.has(action.environmentId));
    for (const key of Object.keys(this.commitDrafts)) {
      if (!registeredEnvironments.has(key.slice(0, key.indexOf(":")))) delete this.commitDrafts[key];
    }
    this.bootstrapping = state.loading;
    this.connectionError =
      state.connection?.phase === "blocked" || state.connection?.phase === "offline";
    this.startError = state.error;
    if (this.connectionError && this.runtime.tabOwnership !== "external") {
      void this.navigate("/");
    }

    if (!state.client || !state.workspace || !state.workspaceState) {
      if (this.runtime.tabOwnership === "external") { this.client = null; this.workspace = null; this.workspaceState = null; this.activeRepositoryId = null; this.openRepos = []; }
      return;
    }
    this.client = state.client;
    this.workspace = state.workspace;
    if (this.runtime.tabOwnership === "external") {
      this.repositoryCatalog = [...(state.catalogs[state.workspaceState.environmentId]?.repositories ?? [])];
    }
    this.applyWorkspaceState(state.workspaceState);
    if (this.runtime.tabOwnership !== "external" && this.appliedRuntimeWorkspace !== state.workspace) {
      // Only a cold start resumes. A later session replacement must not pull
      // the user out of the page they are on.
      const isColdStart = this.appliedRuntimeWorkspace === null;
      this.appliedRuntimeWorkspace = state.workspace;
      void this.refreshRepositoryCatalog(state.client)
        .then(async () => {
          if (
            !this.isDesktop &&
            !state.workspace!.state.openRepositoryIds.length &&
            this.repositoryCatalog.length === 1 && !this.repositoryCatalog[0].missing
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
    if (!repositoryId || this.workspaceState?.repositories[repositoryId]?.repository.missing) return;
    if (this.currentRouteId !== HOME_ROUTE_ID) return;
    this.hasResumed = true;
    await this.navigate(repositoryPath(repositoryId), { replaceState: true });
  }

  private applyWorkspaceState(state: ClientWorkspaceState): void {
    const graph = state.activeRepositoryId ? state.repositories[state.activeRepositoryId]?.snapshot?.graph : undefined;
    const metadataRevision = state.activeRepositoryId && this.workspace?.environmentId === state.environmentId
      ? this.workspace.repositoryMetadataRevision?.(state.activeRepositoryId) ?? 0 : 0;
    if (graph !== this.amendSnapshotGraph || metadataRevision !== this.amendMetadataRevision) {
      this.amendSnapshotGraph = graph;
      this.amendMetadataRevision = metadataRevision;
      this.amendRefreshGeneration += 1;
    }
    const previousRepos = this.runtime.tabOwnership === "external"
      ? state.openRepositoryIds.flatMap((id) => { const value = this.repositorySelections.get(scopedRepositoryKey({ environmentId: state.environmentId, repositoryId: id })); return value ? [value] : []; })
      : this.workspaceState?.environmentId === state.environmentId ? this.openRepos : [];
    this.workspaceState = state;
    this.repositoryCatalog = this.mergeRepositoryCatalog(this.repositoryCatalog, state);
    this.activeRepositoryId = state.activeRepositoryId;
    this.openRepos = state.openRepositoryIds.flatMap((repositoryId) => {
      const repositoryState = state.repositories[repositoryId];

      if (!repositoryState) {
        return [];
      }

      const snapshot = repositoryState.snapshot;
      const previousRepo = previousRepos.find((candidate) => candidate.id === repositoryId);

      return [
        {
          id: repositoryState.repository.id,
          title: this.repositoryTitle(repositoryState.repository),
          root: repositoryState.repository.root,
          isWorktree: repositoryState.repository.isWorktree === true,
          snapshot,
          error: repositoryState.error?.message ?? null,
          loading: repositoryState.loading || repositoryState.refreshing,
          ...reconcileRepositorySelection(previousRepo, snapshot),
        },
      ];
    });
    if (this.runtime.tabOwnership === "external") {
      for (const repository of this.openRepos) this.repositorySelections.set(scopedRepositoryKey({ environmentId: state.environmentId, repositoryId: repository.id }), repository);
    }
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
        .filter((repository) => repository.isWorktree !== true || repository.missing)
        .map((repository) => [repository.id, repository]),
    );

    for (const repositoryState of state ? Object.values(state.repositories) : []) {
      if (repositoryState.repository.isWorktree !== true || repositoryState.repository.missing) {
        const catalogEntry = merged.get(repositoryState.repository.id);
        merged.set(repositoryState.repository.id, catalogEntry ?? repositoryState.repository);
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
    options: { navigate?: boolean; successMessage?: string; errorMessage?: string; refreshCatalog?: boolean } = {},
  ): Promise<boolean> {
    const request = ++this.activeWorkspaceRequest;
    const environmentId = this.workspace?.environmentId;
    this.operationPending = true;
    this.startError = "";

    try {
      await action();
      if (options.refreshCatalog && environmentId) void this.runtime.refreshEnvironmentCatalog?.(environmentId);
      if (request === this.activeWorkspaceRequest && options.navigate !== false) {
        await this.navigateToActiveRepository();
      }
      if (request === this.activeWorkspaceRequest) this.operationPending = false;
      if (options.successMessage) toast.success(options.successMessage);
      return true;
    } catch (caught) {
      if (request === this.activeWorkspaceRequest) this.operationPending = false;
      if (options.errorMessage) toast.error(options.errorMessage, { description: formatError(caught) });
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
    if (this.runtime.tabOwnership === "external" && this.connectionEnvironmentId) {
      this.startError = "Retrying the GitGui connection…";
      try {
        await this.runtime.retry(this.connectionEnvironmentId);
      } catch (caught) {
        this.startError = formatError(caught);
      }
      return;
    }
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

  async retryEnvironmentCatalog(environmentId: string): Promise<void> {
    const entry = this.environmentEntries.find((item) => item.registration.environmentId === environmentId);
    if (!entry) return;
    try {
      if (entry.connection.phase === "connected") await this.runtime.refreshEnvironmentCatalog(environmentId);
      else await this.runtime.retry(environmentId);
    } catch (error) {
      toast.error(`Could not retry ${entry.registration.displayName}`, { description: formatError(error) });
    }
  }

  async retryActiveRepository(): Promise<void> {
    const environmentId = this.connectionEnvironmentId, repositoryId = this.activeRepositoryId;
    if (!environmentId || !repositoryId) return;
    const entry = this.environmentEntries.find((item) => item.registration.environmentId === environmentId);
    if (!entry) return;
    try {
      if (entry.connection.phase === "connected") {
        await this.runtime.getEnvironmentWorkspace(environmentId)?.workspace.refreshRepository(repositoryId);
      } else await this.runtime.retry(environmentId);
    } catch (error) {
      toast.error(`Could not reload repository on ${entry.registration.displayName}`, { description: formatError(error) });
    }
  }

  async chooseRepository(): Promise<void> {
    if (this.externalTabs && this.connectionEnvironmentId) return this.chooseRepositoryForEnvironment(this.connectionEnvironmentId);
    const availability = this.selectedRepositoryActions.open;
    if (!availability.allowed) { this.startError = availability.reason; return; }
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
        await this.runWorkspaceCommand(() => this.requireWorkspace().openRepositoryPath(selectedPath), {
          successMessage: "Repository opened",
          errorMessage: "Could not open repository",
          refreshCatalog: true,
        });
      }
    } catch (caught) {
      toast.error("Could not choose repository", { description: formatError(caught) });
    }
  }

  async chooseRepositoryForEnvironment(environmentId: string): Promise<void> {
    const availability = this.repositoryActionAvailability(environmentId, "open");
    if (!availability.allowed) { this.startError = availability.reason; return; }
    this.cancelRepositorySwitch();
    const entry = this.environmentEntries.find((candidate) => candidate.registration.environmentId === environmentId);
    if (!entry || !this.applicationWorkspace) return;
    if (!this.isDesktop || entry.registration.target.kind !== "primary") {
      this.repositoryPathEnvironmentId = environmentId;
      this.repositoryPathValue = "";
      this.repositoryPathError = "";
      this.repositoryPathDialogOpen = true;
      return;
    }
    const request = this.beginRepositorySwitch();
    try {
      const path = await this.runtime.pickFolder();
      if (!path || request.signal.aborted) return;
      await this.applicationWorkspace.openPath(environmentId, path, undefined, request.signal);
      if (request.signal.aborted) return;
      const state = this.applicationWorkspace.state;
      const target = state.tabs.find((tab) => tab.tabId === state.activeTabId)?.target;
      if (target) await this.navigate(scopedRepositoryPath(target.environmentId, target.repositoryId));
    } catch (error) { if (!request.signal.aborted) toast.error("Could not open repository", { description: formatError(error) }); }
    finally { if (this.pendingRepositorySwitch === request) this.pendingRepositorySwitch = null; }
  }

  async openRepository(repositoryId: string): Promise<boolean> {
    if (this.runtime.tabOwnership === "external") {
      const environmentId = this.connectionEnvironmentId;
      return environmentId ? this.openScopedRepository({ environmentId, repositoryId }) : false;
    }
    const opened = await this.runWorkspaceCommand(() => this.requireWorkspace().openKnownRepository(repositoryId));
    if (opened) {
      const repository = this.workspace?.state.repositories[repositoryId]?.repository;
      if (repository) this.repositoryCatalog = this.repositoryCatalog.map((entry) => entry.id === repositoryId ? repository : entry);
    }
    return opened;
  }

  async removeRepository(repositoryId: string): Promise<void> {
    if (!this.selectedRepositoryActions.remove.allowed) {
      toast.error("Could not remove repository", { description: this.selectedRepositoryActions.remove.reason }); return;
    }
    const draftKey = this.workspaceState?.environmentId
      ? `${this.workspaceState.environmentId}:${repositoryId}`
      : null;
    const removed = await this.runWorkspaceCommand(
      () => this.requireWorkspace().removeRepository(repositoryId),
      { navigate: false, refreshCatalog: true },
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
    if (this.runtime.tabOwnership === "external") { await this.selectApplicationTab(repositoryId); return; }
    await this.runWorkspaceCommand(() => this.requireWorkspace().selectRepository(repositoryId));
  }

  async closeRepository(repositoryId: string): Promise<void> {
    if (this.runtime.tabOwnership === "external") { await this.closeApplicationTab(repositoryId); return; }
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
    if (this.runtime.tabOwnership === "external") {
      const source = this.applicationTabs.tabs.find((tab) => tab.tabId === this.applicationTabs.activeTabId);
      if (!source || !this.applicationWorkspace) return;
      const request = this.beginRepositorySwitch();
      try {
        await this.applicationWorkspace.switchPath(source.tabId, path, source.target, request.signal);
        if (request.signal.aborted) return;
        const target = this.applicationWorkspace.state.tabs.find((tab) => tab.tabId === source.tabId)?.target;
        if (target) await this.navigate(scopedRepositoryPath(target.environmentId, target.repositoryId));
      } catch (error) { if (!request.signal.aborted) toast.error("Could not switch worktree", { description: formatError(error) }); }
      finally { if (this.pendingRepositorySwitch === request) this.pendingRepositorySwitch = null; }
      return;
    }
    const repositoryId = this.activeRepositoryId;
    if (!path.trim() || !repositoryId || !this.workspace || this.operationPending) {
      return;
    }

    void this.runWorkspaceCommand(
      () => this.requireWorkspace().switchRepositoryPath(path, repositoryId),
      { errorMessage: "Could not switch worktree", refreshCatalog: true },
    );
  }

  async openWorktreeInNewTab(path: string): Promise<void> {
    this.cancelRepositorySwitch();
    if (this.runtime.tabOwnership === "external") {
      const source = this.applicationTabs.tabs.find((tab) => tab.tabId === this.applicationTabs.activeTabId);
      if (!source || !this.applicationWorkspace) return;
      const request = this.beginRepositorySwitch();
      try {
        await this.applicationWorkspace.openPath(source.target.environmentId, path, source, request.signal);
        if (request.signal.aborted) return;
        const target = this.applicationWorkspace.state.tabs.find((tab) => tab.tabId === this.applicationWorkspace?.state.activeTabId)?.target;
        if (target) await this.navigate(scopedRepositoryPath(target.environmentId, target.repositoryId));
      } catch (error) { if (!request.signal.aborted) toast.error("Could not open worktree", { description: formatError(error) }); }
      finally { if (this.pendingRepositorySwitch === request) this.pendingRepositorySwitch = null; }
      return;
    }
    const workspace = this.workspace;
    if (!path.trim() || !workspace || this.operationPending) return;
    await this.runWorkspaceCommand(() => workspace.openRepositoryPathInNewTab(path), {
      errorMessage: "Could not open worktree",
      refreshCatalog: true,
    });
  }

  async openScopedRepository(target: ScopedRepositoryRef, source?: { tabId: string; target: ScopedRepositoryRef }): Promise<boolean> {
    this.cancelRepositorySwitch();
    if (!this.applicationWorkspace) return false;
    const request = this.beginRepositorySwitch();
    try {
      await this.applicationWorkspace.open(target, source, request.signal);
      if (request.signal.aborted) return false;
      await this.navigate(scopedRepositoryPath(target.environmentId, target.repositoryId));
      return true;
    } catch (error) { if (!request.signal.aborted) toast.error("Could not open repository", { description: formatError(error) }); return false; }
    finally { if (this.pendingRepositorySwitch === request) this.pendingRepositorySwitch = null; }
  }

  async activateRouteRepository(target: ScopedRepositoryRef, signal: AbortSignal): Promise<void> {
    this.cancelRepositorySwitch();
    if (!this.applicationWorkspace) throw new Error("Application workspace is not ready.");
    await this.applicationWorkspace.activate(target, signal);
  }

  async removeScopedRepository(target: ScopedRepositoryRef): Promise<void> {
    const availability = this.repositoryActionAvailability(target.environmentId, "remove");
    if (!availability.allowed) { toast.error("Could not remove repository", { description: availability.reason }); return; }
    this.cancelRepositorySwitch();
    const application = this.applicationWorkspace;
    const data = this.runtime.getEnvironmentWorkspace(target.environmentId);
    if (!application || !data) return;
    const existing = application.state.tabs.find((tab) => sameRepository(tab.target, target));
    let removed = false;
    try {
      await data.client.removeRepository(target.repositoryId);
      removed = true;
      if (existing) await application.closeIfMatches(existing.tabId, target);
      // The repository route observes the resulting active tab and owns URL
      // replacement. Home/settings must survive a late removal unchanged.
    } catch (error) {
      if (removed) toast.warning("Repository removed; the tab could not be closed", { description: formatError(error) });
      else toast.error("Could not remove repository", { description: formatError(error) });
    } finally { if (removed) void this.runtime.refreshEnvironmentCatalog(target.environmentId); }
  }

  async selectApplicationTab(tabId: string): Promise<void> {
    this.cancelRepositorySwitch();
    if (!this.applicationWorkspace) return;
    try {
      await this.applicationWorkspace.select(tabId);
      const target = this.applicationWorkspace.state.tabs.find((tab) => tab.tabId === tabId)?.target;
      if (target) await this.navigate(scopedRepositoryPath(target.environmentId, target.repositoryId));
    } catch (error) { toast.error("Could not select repository", { description: formatError(error) }); }
  }

  async closeApplicationTab(tabId: string): Promise<void> {
    this.cancelRepositorySwitch();
    if (!this.applicationWorkspace) return;
    try {
      await this.applicationWorkspace.close(tabId);
    } catch (error) { toast.error("Could not close repository", { description: formatError(error) }); }
  }

  async switchScopedRepository(target: ScopedRepositoryRef, source: { tabId: string; target: ScopedRepositoryRef }): Promise<void> {
    if (!this.applicationWorkspace) return;
    const request = this.beginRepositorySwitch();
    try {
      await this.applicationWorkspace.switch(source.tabId, target, source.target, request.signal);
      if (request.signal.aborted) return;
      await this.navigate(scopedRepositoryPath(target.environmentId, target.repositoryId));
    } catch (error) { if (!request.signal.aborted) toast.error("Could not switch repository", { description: formatError(error) }); }
    finally { if (this.pendingRepositorySwitch === request) this.pendingRepositorySwitch = null; }
  }

  closeRepositoryPathDialog(): void {
    if (this.externalTabs && this.repositoryPathPending) this.cancelRepositorySwitch();
    if (!(this.externalTabs ? this.repositoryPathPending : this.operationPending)) {
      this.repositoryPathDialogOpen = false;
      this.repositoryPathError = "";
    }
  }

  async submitRepositoryPath(): Promise<void> {
    if (!this.pathOpenAvailability.allowed) { this.repositoryPathError = this.pathOpenAvailability.reason; return; }
    const path = this.repositoryPathValue.trim();
    if (!path) {
      this.repositoryPathError = "Enter a repository path on the connected host.";
      return;
    }

    if (this.runtime.tabOwnership === "external") {
      const environmentId = this.repositoryPathEnvironmentId;
      if (!environmentId || !this.applicationWorkspace || this.repositoryPathPending) return;
      this.repositoryPathPending = true;
      const request = this.beginRepositorySwitch();
      this.pendingPathRequest = request;
      try {
        await this.applicationWorkspace.openPath(environmentId, path, undefined, request.signal);
        if (request.signal.aborted) return;
        this.repositoryPathDialogOpen = false;
        const state = this.applicationWorkspace.state;
        const target = state.tabs.find((tab) => tab.tabId === state.activeTabId)?.target;
        if (target) await this.navigate(scopedRepositoryPath(target.environmentId, target.repositoryId));
      } catch (error) { if (!request.signal.aborted) this.repositoryPathError = formatError(error); }
      finally { if (this.pendingPathRequest === request) { this.repositoryPathPending = false; this.pendingPathRequest = null; } if (this.pendingRepositorySwitch === request) this.pendingRepositorySwitch = null; }
      return;
    }
    const workspace = this.workspace;
    if (!workspace || this.operationPending) return;
    this.repositoryPathDialogOpen = false;
    this.repositoryPathError = "";
    this.repositoryPathValue = "";
    await this.runWorkspaceCommand(() => workspace.openRepositoryPath(path), {
      successMessage: "Repository opened",
      errorMessage: "Could not open repository",
      refreshCatalog: true,
    });
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
  async prepareCreateRepository(environmentId?: string): Promise<void> {
    const preparation = ++this.createPreparation;
    const registered = (id: string | null | undefined) => this.environmentEntries.some((entry) => entry.registration.environmentId === id) ? id : undefined;
    this.createRepositoryEnvironmentId = environmentId ?? registered(this.connectionEnvironmentId) ?? registered(this.runtime.state.registry.selectedEnvironmentId)
      ?? this.operationEnvironments.find((entry) => entry.primary)?.id ?? this.operationEnvironments[0]?.id ?? null;
    this.createRepositoryParentPath = "";
    this.createRepositoryName = "";
    this.createRepositoryInitialBranch = "";
    this.createRepositoryInitializeLfs = false;
    this.createRepositoryError = this.externalTabs && !this.createRepositoryEnvironmentId ? "No environment is available. Add a connection before creating a repository." : "";
    this.createRepositoryPrepared = true;
    this.createRepositoryPreparing = true;
    try {
      if (!this.externalTabs || this.canBrowseCreateLocation) {
        const path = await resolveProjectsLocation();
        if (preparation === this.createPreparation) this.createRepositoryParentPath = path;
      }
    } catch (error) {
      if (preparation === this.createPreparation) this.createRepositoryError = formatError(error);
    } finally {
      if (preparation === this.createPreparation) this.createRepositoryPreparing = false;
    }
  }

  async beginCreateRepository(environmentId?: string): Promise<void> {
    this.cancelRepositorySwitch();
    await this.prepareCreateRepository(environmentId);
    await this.showCreateRepositoryView();
  }

  async submitCreateRepository(): Promise<void> {
    if (!this.createAvailability.allowed) { this.createRepositoryError = this.createAvailability.reason; return; }
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
    if (this.runtime.tabOwnership === "external") {
      const environmentId = this.createRepositoryEnvironmentId;
      if (!environmentId || !this.environmentEntries.some((entry) => entry.registration.environmentId === environmentId)) {
        this.createRepositoryError = "The selected environment is unavailable. Return to Repositories and choose a connection.";
        return;
      }
      if (!this.applicationWorkspace || !this.applicationReady) {
        this.createRepositoryError = "The workspace is still starting. Try again when it is ready.";
        return;
      }
      if (this.createRepositoryPending) return;
      this.pendingCreateEnvironments[environmentId] = true;
      const request = this.beginRepositorySwitch();
      try {
        const opened = await this.applicationWorkspace.create(environmentId, this.createRepositoryParentPath.trim(), name, {
          ...(this.createRepositoryInitialBranch.trim() ? { initialBranch: this.createRepositoryInitialBranch.trim() } : {}),
          initializeLfs: this.createRepositoryInitializeLfs,
        }, request.signal);
        if (!opened || request.signal.aborted) { if (!opened) toast.success("Repository created", { description: "Open it from Repositories when you are ready." }); return; }
        const state = this.applicationWorkspace.state;
        const target = state.tabs.find((tab) => tab.tabId === state.activeTabId)?.target;
        if (target) await this.navigate(scopedRepositoryPath(target.environmentId, target.repositoryId));
      } catch (error) {
        if (!request.signal.aborted) this.createRepositoryError = formatError(error);
        else toast.warning("Could not confirm repository creation", { description: "Check Repositories on the selected environment before retrying." });
      }
      finally { delete this.pendingCreateEnvironments[environmentId]; if (this.pendingRepositorySwitch === request) this.pendingRepositorySwitch = null; }
      return;
    }
    const created = await this.runWorkspaceCommand(() =>
      this.requireWorkspace().createRepository(this.createRepositoryParentPath.trim(), name, {
        ...(this.createRepositoryInitialBranch.trim()
          ? { initialBranch: this.createRepositoryInitialBranch.trim() }
          : {}),
        initializeLfs: this.createRepositoryInitializeLfs,
      }),
      { refreshCatalog: true },
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
    if (!this.createAvailability.allowed) { this.createRepositoryError = this.createAvailability.reason; return; }
    if (!this.isDesktop || (this.runtime.tabOwnership === "external" && !this.canBrowseCreateLocation)) {
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
    if (!(this.externalTabs ? this.createRepositoryPending : this.operationPending)) {
      this.createRepositoryError = "";
      this.createRepositoryPrepared = false;
      await this.showStartView();
    }
  }

  repositoryActionAvailability(environmentId: string | null, action: RepositoryManagementAction) {
    const entry = this.environmentEntries.find((candidate) => candidate.registration.environmentId === environmentId);
    if (!entry) return { allowed: false, reason: "The selected environment is unavailable. Return to Repositories and choose a connection." };
    const view = environmentId ? this.environmentViews[environmentId] : undefined;
    return repositoryManagementAvailability(action, entry?.connection.phase === "connected", view?.sessionScopes, view?.welcome?.capabilities);
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
    if (this.runtime.tabOwnership === "external" && this.connectionEnvironmentId) {
      const active = this.openRepos.find((repo) => repo.id === this.activeRepositoryId);
      if (active) this.repositorySelections.set(scopedRepositoryKey({ environmentId: this.connectionEnvironmentId, repositoryId: active.id }), active);
    }
  }

  selectCommit(commit: CommitInfo): void {
    this.setComparisonHash(null);
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
    this.selectCommit(commit);
    this.setComparisonHash(commit.hash);
  }

  private setComparisonHash(hash: string | null): void {
    if (!this.connectionEnvironmentId || !this.activeRepositoryId) return;
    const key = scopedRepositoryKey({ environmentId: this.connectionEnvironmentId, repositoryId: this.activeRepositoryId });
    if (hash === null) delete this.comparisonHashes[key];
    else this.comparisonHashes[key] = hash;
  }

  /** Sidebar and graph share a real stash selection, never a fabricated commit. */
  selectStash(stash: StashInfo): void {
    const selected = reconcileSelectedStash(stash, this.snapshot?.stashes ?? []);
    if (!selected) return;
    this.setComparisonHash(null);
    this.updateActiveRepository((repo) => ({
      ...repo,
      selectedGraphItem: { type: "stash", stash: selected },
      selectedFile: null,
      selectedFileSource: null,
      selectedChangePaths: [],
      selectedChangeSource: null,
    }));
  }

  selectRef(ref: CommitRef): void {
    const commit = this.snapshot?.commits.find((candidate) => candidate.hash === ref.target);
    if (commit && this.activeRepositoryId) {
      if (ref.refType === "tag" && this.hiddenGraphRefKeys.has(graphRefKey(ref))) this.toggleGraphRefs([ref], true);
      this.scrollToCommit = {
        id: ++this.nextScrollCommandId,
        repositoryId: this.activeRepositoryId,
        hash: commit.hash,
      };
      this.selectCommit(commit);
    }
  }

  selectChanges(): void {
    this.setComparisonHash(null);
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
    this.graphScrollPositions.set(this.repositoryStateKey(repositoryId), scrollTop);
  }

  graphScrollTopFor(repositoryId: string): number {
    return this.graphScrollPositions.get(this.repositoryStateKey(repositoryId)) ?? 0;
  }

  private repositoryStateKey(repositoryId: string): string {
    return this.connectionEnvironmentId
      ? scopedRepositoryKey({ environmentId: this.connectionEnvironmentId, repositoryId })
      : repositoryId;
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
    const openRepoIds = new Set(repos.map((repo) => this.repositoryStateKey(repo.id)));

    // Other environments have their own open tabs and prefetch lifetimes.
    if (this.runtime.tabOwnership === "external") return;

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

      const key = this.repositoryStateKey(repo.id);
      if (this.prefetchedInitialCommits.get(key) === signature) {
        continue;
      }

      this.prefetchedInitialCommits.set(key, signature);
      void this.workspace.prefetchCommitFiles(repo.id, commitHashes).catch(() => {
        if (this.prefetchedInitialCommits.get(key) === signature) this.prefetchedInitialCommits.delete(key);
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Git actions                                                             */
  /* ---------------------------------------------------------------------- */

  private requestGitAction(request: GitActionRequest, queueWhenBusy = false): void {
    if (this.repositoryDisconnected || !this.repositoryCanOperate) return;
    const repositoryId = this.activeRepositoryId;
    const client = this.client, workspace = this.workspace, environmentId = this.connectionEnvironmentId;
    if (!repositoryId || !client || !workspace || !environmentId) {
      return;
    }

    if (this.pendingGitActions[scopedRepositoryKey({ environmentId, repositoryId })]) {
      if (queueWhenBusy) {
        this.queuedGitActions = [...this.queuedGitActions, { ...request, repositoryId, environmentId, client, workspace }];
      }
      return;
    }

    void this.runGitAction({ ...request, repositoryId, environmentId, client, workspace });
  }

  private async runGitAction(request: PendingGitAction): Promise<void> {
    const workspace = request.workspace;
    const action = this.beginGitAction(request, request.kind, request.label);

    let applied = false;
    try {
      const mutationResult = await request.action(request.repositoryId, request.client);
      applied = true;
      if (request.affectedPaths?.length) workspace.invalidateFileContent(request.repositoryId, request.affectedPaths);
      await request.onApplied?.(mutationResult);
      const refreshedState = await this.refreshAfterMutation(workspace, request.repositoryId, request.kind, mutationResult);
      // End pending UI before publishing the result, including custom toasts.
      this.releaseGitAction(action);
      if (request.kind === "switchBranch" && this.hasUnmergedFiles(request.repositoryId, refreshedState)) {
        toast.warning("Switched with conflicts", { description: "Resolve the highlighted conflicts." });
      } else if (request.onSucceeded) {
        request.onSucceeded(mutationResult);
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
          await request.onApplied?.();
        }
        this.releaseGitAction(action);
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
        this.releaseGitAction(action);
        if (!request.onFailed?.(caught)) {
          toast.error(`${request.label} failed`, { description: summarizeGitError(caught) });
        }
      }
    } finally {
      this.releaseGitAction(action);
      this.runNextGitAction(request);
    }
  }

  private beginGitAction(context: ScopedRepositoryRef, kind: string, label: string) {
    const action = { environmentId: context.environmentId, repositoryId: context.repositoryId, kind, label };
    this.pendingGitActions = { ...this.pendingGitActions, [scopedRepositoryKey(context)]: action };
    return action;
  }

  private releaseGitAction(action: NonNullable<WorkspaceStore["gitAction"]>): void {
    const key = scopedRepositoryKey(action);
    if (this.pendingGitActions[key] !== action) return;
    const next = { ...this.pendingGitActions };
    delete next[key];
    this.pendingGitActions = next;
  }

  private runNextGitAction(context: ScopedRepositoryRef): void {
    if (this.pendingGitActions[scopedRepositoryKey(context)]) return;
    const index = this.queuedGitActions.findIndex((action) => sameRepository(action, context));
    if (index < 0) return;
    const next = this.queuedGitActions[index];
    this.queuedGitActions = this.queuedGitActions.filter((_, position) => position !== index);
    if (this.externalTabs || this.workspace === next.workspace) void this.runGitAction(next);
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
      action: (repositoryId, client) =>
        client.switchBranch({
          repositoryId,
          name: branchName,
          merge: readBranchSwitchMergePreference(),
        }),
    });
  }

  fetchRepository(): void {
    const client = this.client, repositoryId = this.activeRepositoryId, environmentId = this.workspaceState?.environmentId;
    if (!client || !repositoryId || !environmentId) return;
    this.requestGitAction({
      kind: "fetch",
      label: "Fetching",
      successMessage: "Fetched from remote",
      action: (repositoryId) => client.fetch(repositoryId),
      onSucceeded: (result) => {
        const receipt = result as GitFetchResult;
        const conflicts = parseTagConflicts(receipt.tagConflicts);
        if (conflicts === null) { toast.warning("Fetch completed; tag conflict details were invalid"); return; }
        if (conflicts.length && repositoryId === this.activeRepositoryId && environmentId === this.workspaceState?.environmentId) {
          this.tagFetchReview = { repositoryId, environmentId, remote: receipt.remote ?? "remote", conflicts, selectedNames: new Set(conflicts.map((conflict) => conflict.name)), error: "" };
        } else toast.success("Fetched branches and tags");
      },
    });
  }

  pullRepository(): void {
    this.requestGitAction({
      kind: "pull",
      label: "Pulling",
      successMessage: "Pulled from remote",
      action: (repositoryId, client) => client.pull(repositoryId),
    });
  }

  pushRepository(): void {
    this.requestGitAction({
      kind: "push",
      label: "Pushing",
      successMessage: "Pushed to remote",
      action: (repositoryId, client) => client.push(repositoryId),
      onSucceeded: (result) => {
        const receipt = result as GitPushResult;
        if (typeof receipt.tagError === "string" && receipt.tagError) toast.warning("Push completed with rejected refs", { description: receipt.tagError });
        else toast.success("Pushed branches and tags");
      },
    });
  }

  checkoutTag(tag: CommitRef): void {
    const client = this.client;
    if (!client || !this.canCheckoutTag || !tag.objectId) return;
    const params = { name: tagName(tag), expectedObjectId: tag.objectId };
    this.requestGitAction({ kind: "checkoutTag", label: `Checking out ${params.name}`, successMessage: `Checked out ${params.name} (detached HEAD)`,
      action: (repositoryId) => client.checkoutTag({ repositoryId, ...params }) });
  }

  pushTag(tag: CommitRef): void {
    const client = this.client;
    if (!client || !this.canPushTag || !tag.objectId) return;
    const params = { name: tagName(tag), expectedObjectId: tag.objectId };
    this.requestGitAction({ kind: "pushTag", label: `Pushing tag ${params.name}`, successMessage: `Pushed tag ${params.name}`,
      action: (repositoryId) => client.pushTag({ repositoryId, ...params }) });
  }

  loadTagDetails(tag: CommitRef): Promise<GitTagDetails> {
    const client = this.client, repositoryId = this.activeRepositoryId, environmentId = this.workspaceState?.environmentId;
    if (!client || !repositoryId || !environmentId || !tag.objectId) return Promise.reject(new Error("Tag details unavailable"));
    if (tag.objectId === tag.target) return Promise.resolve({ annotated: false, message: null, tagger: null, timestamp: null, hasSignature: false });
    if (!client.serverWelcome.capabilities.includes("git.tag.details")) return Promise.reject(new Error("Annotation details are unavailable on this server"));
    const key = `${environmentId}\0${repositoryId}\0${tag.name}\0${tag.objectId}`;
    const cached = this.tagDetailsCache.get(key);
    if (cached) return cached;
    const promise = client.getTagDetails({ repositoryId, name: tagName(tag), expectedObjectId: tag.objectId }).catch((error) => { this.tagDetailsCache.delete(key); throw error; });
    if (this.tagDetailsCache.size >= 64) this.tagDetailsCache.delete(this.tagDetailsCache.keys().next().value!);
    this.tagDetailsCache.set(key, promise);
    return promise;
  }

  toggleFetchedTag(name: string, selected: boolean): void {
    if (!this.tagFetchReview || this.gitActionPending) return;
    const next = new Set(this.tagFetchReview.selectedNames);
    if (selected) next.add(name); else next.delete(name);
    this.tagFetchReview.selectedNames = next;
  }

  confirmFetchedTags(): void {
    const review = this.tagFetchReview, client = this.client;
    if (!review || !client || this.gitActionPending || review.repositoryId !== this.activeRepositoryId || review.environmentId !== this.workspaceState?.environmentId) return;
    if (!client.serverWelcome.capabilities.includes("git.tag.apply_fetch")) { review.error = "This server cannot apply reviewed tag replacements."; return; }
    const conflicts = review.conflicts.filter((conflict) => review.selectedNames.has(conflict.name))
      .map(({ name, localObjectId, remoteObjectId }) => ({ name, localObjectId, remoteObjectId }));
    if (!conflicts.length) return;
    this.requestGitAction({ kind: "replaceFetchedTags", label: "Updating fetched tags", successMessage: `Updated ${conflicts.length} local tags`,
      action: (repositoryId) => client.applyFetchedTags({ repositoryId, conflicts }),
      onApplied: () => { if (this.tagFetchReview === review) this.tagFetchReview = null; },
      onFailed: (error) => { if (this.tagFetchReview !== review) return false; review.error = summarizeGitError(error); return true; },
    });
  }

  stageFile(file: ChangedFile): void {
    this.requestGitAction(
      {
        kind: "stage",
        label: "Staging",
        notifySuccess: false,
        affectedPaths: [file.path],
        action: (repositoryId, client) => client.stage(repositoryId, [file.path]),
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
        action: (repositoryId, client) => client.stage(repositoryId, paths),
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
        action: (repositoryId, client) => client.unstage(repositoryId, [file.path]),
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
        action: (repositoryId, client) => client.unstage(repositoryId, paths),
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
        action: (repositoryId, client) => client.stage(repositoryId),
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
        action: (repositoryId, client) => client.unstage(repositoryId),
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
    const workspace = this.workspace;
    if (!client || !workspace || !repositoryId || !environmentId || this.gitActionPending || !paths.length) return;
    const generation = ++this.discardPreviewGeneration;
    const dialog = { repositoryId, environmentId, client, workspace, files: [] as GitDiscardFile[], loading: true, error: "" };
    this.discardDialog = dialog;
    try {
      const files = await client.previewDiscard(repositoryId, paths);
      if (generation === this.discardPreviewGeneration && this.workspace === workspace && this.client === client && this.discardDialog?.repositoryId === repositoryId && this.discardDialog.environmentId === environmentId) {
        this.discardDialog = { ...dialog, files, loading: false };
      }
    } catch (caught) {
      if (generation === this.discardPreviewGeneration && this.workspace === workspace && this.client === client && this.discardDialog?.repositoryId === repositoryId && this.discardDialog.environmentId === environmentId) {
        this.discardDialog = null;
        toast.error("Could not review changes", { description: summarizeGitError(caught) });
      }
    }
  }

  confirmDiscard(files: GitDiscardFile[], deleteUntracked: boolean): void {
    const dialog = this.discardDialog;
    if (!dialog || dialog.loading || this.gitActionPending || !files.length ||
      dialog.workspace !== this.workspace || dialog.client !== this.client ||
      dialog.repositoryId !== this.activeRepositoryId || dialog.environmentId !== this.workspaceState?.environmentId ||
      new Set(files.map((file) => file.path)).size !== files.length ||
      files.some((file) => !dialog.files.some((reviewed) => reviewed.path === file.path && reviewed.revision === file.revision && reviewed.untracked === file.untracked)) ||
      files.some((file) => file.untracked) && !deleteUntracked) return;
    this.discardDialog = null;
    void this.runDiscard(dialog, files.map((file) => ({ ...file })), deleteUntracked);
  }

  private async runDiscard(dialog: NonNullable<WorkspaceStore["discardDialog"]>, files: GitDiscardFile[], deleteUntracked: boolean): Promise<void> {
    const { workspace, client, environmentId, repositoryId } = dialog;
    const generation = ++this.discardActionGeneration;
    const checkpoint = workspace.beginDiscard(repositoryId);
    const paths = files.map((file) => file.path);
    const submittedAction = this.beginGitAction({ environmentId, repositoryId }, "discard", "Discarding");
    const current = () => generation === this.discardActionGeneration && this.workspace === workspace;
    let outcome: GitDiscardResult | undefined;
    let failure: unknown;
    try {
      outcome = validateDiscardReceipt(files, await client.discard({ repositoryId, files, deleteUntracked }));
    } catch (error) {
      failure = error;
    }
    workspace.reconcileDiscard(checkpoint, paths, outcome?.completedPaths ?? []);
    // Selection can change while the original RPC is running. Release exactly
    // its pending action, even if another environment is now on screen.
    this.releaseGitAction(submittedAction);
    if (outcome) {
        if (outcome.error) {
          toast.error("Discard stopped", {
            description: `${outcome.error}\nChanged: ${outcome.completedPaths.join(", ") || "none"}\nRemaining: ${outcome.remainingPaths.join(", ")}`,
          });
        } else {
          toast.success(`Discarded changes in ${outcome.completedPaths.length} files`);
        }
    } else {
      const notice = discardFailureNotice(failure);
      toast[notice.uncertain ? "warning" : "error"](notice.title, { description: notice.description });
    }
    // The existing watcher scheduler deduplicates this with filesystem events.
    // It runs after interactive work and never owns or repeats the mutation.
    workspace.queueRepositoryStatusRefresh(repositoryId, (error) => {
      if (!current()) return;
      toast.warning("Discard status refresh failed", {
        description: error.message,
        action: { label: "Retry refresh", onClick: () => workspace.queueRepositoryStatusRefresh(repositoryId) },
      });
    });
    this.runNextGitAction({ environmentId, repositoryId });
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

  private prepareGitNameDialog(kind: "branch" | "renameBranch" | "tag" | "stash"): boolean {
    const repositoryId = this.activeRepositoryId;
    const environmentId = this.workspaceState?.environmentId;
    if (!repositoryId || !environmentId || !this.client || this.gitActionPending) return false;
    this.gitNameDialogContext = { repositoryId, environmentId };
    this.gitNameDialogKind = kind;
    this.gitNameDialogValue = "";
    this.gitNameDialogError = "";
    this.gitNameDialogCheckout = true;
    return true;
  }

  openBranchDialog(commit?: CommitInfo): void {
    if (this.prepareGitNameDialog("branch") && commit) {
      this.gitNameDialogContext = { ...this.gitNameDialogContext!, startPoint: commit.hash };
    }
  }

  openRenameBranchDialog(branch: CommitRef): void {
    if (!this.canRenameBranch || branch.refType !== "localBranch") return;
    if (this.prepareGitNameDialog("renameBranch")) {
      this.gitNameDialogContext = { ...this.gitNameDialogContext!, branch };
      this.gitNameDialogValue = branch.shortName;
    }
  }

  openTagDialog(commit: CommitInfo): void {
    if (this.canCreateTag && this.prepareGitNameDialog("tag")) {
      this.gitNameDialogContext = { ...this.gitNameDialogContext!, startPoint: commit.hash };
    }
  }

  openStashDialog(): void {
    this.prepareGitNameDialog("stash");
  }

  private clearGitNameDialog(): void {
    this.gitNameDialogKind = null;
    this.gitNameDialogContext = null;
    this.gitNameDialogValue = "";
    this.gitNameDialogError = "";
  }

  closeGitNameDialog(): void {
    if (!this.gitActionPending) this.clearGitNameDialog();
  }

  submitGitNameDialog(): void {
    const name = this.gitNameDialogValue.trim();
    const context = this.gitNameDialogContext;
    const client = this.client;
    if (!context || !client || this.gitActionPending || context.repositoryId !== this.activeRepositoryId || context.environmentId !== this.workspaceState?.environmentId) return;

    if (this.gitNameDialogKind === "tag") {
      if (!this.canCreateTag || !context.startPoint) return;
      const error = tagNameError(name);
      if (error || this.snapshot?.refs.some((ref) => ref.name === `refs/tags/${name}`)) {
        this.gitNameDialogError = error ?? "A tag with this name already exists.";
        return;
      }
      const target = context.startPoint;
      this.requestGitAction({
        kind: "createTag",
        label: "Creating tag",
        successMessage: `Created tag ${name}`,
        action: (repositoryId) => client.createTag({ repositoryId, name, target }),
        onApplied: () => {
          if (this.gitNameDialogContext === context) {
            this.toggleGraphRefs([{ name: `refs/tags/${name}`, shortName: name, target, refType: "tag" }], true);
            this.clearGitNameDialog();
          }
        },
        onFailed: (caught) => {
          if (this.gitNameDialogContext !== context) return false;
          this.gitNameDialogError = summarizeGitError(caught);
          return true;
        },
      });
      return;
    }

    if (this.gitNameDialogKind === "branch" || this.gitNameDialogKind === "renameBranch") {
      if (!name) {
        this.gitNameDialogError = "Enter a branch name to continue.";
        return;
      }

      const branch = context.branch;
      const checkout = this.gitNameDialogCheckout;
      this.clearGitNameDialog();
      this.requestGitAction({
        kind: branch ? "renameBranch" : "createBranch",
        label: branch ? "Renaming branch" : "Creating branch",
        successMessage: branch ? `Renamed ${branch.shortName} to ${name}` : checkout ? `Created and switched to ${name}` : `Created branch ${name}`,
        action: (repositoryId) => branch
          ? client.renameBranch({ repositoryId, name: branch.shortName, newName: name, expectedTarget: branch.target })
          : client.createBranch({ repositoryId, name, startPoint: context.startPoint, checkout }),
      });
      return;
    }

    this.closeGitNameDialog();
    this.requestGitAction({
      kind: "stash",
      label: "Stashing",
      successMessage: "Changes stashed",
      action: (repositoryId) =>
        client.stashPush({
          repositoryId,
          message: name || undefined,
          includeUntracked: true,
        }),
    });
  }

  openDeleteTagDialog(tag: CommitRef): void {
    const repositoryId = this.activeRepositoryId;
    const environmentId = this.workspaceState?.environmentId;
    if (!repositoryId || !environmentId || !this.canDeleteTag || tag.refType !== "tag" || !tag.objectId) return;
    this.deleteTagDialog = { repositoryId, environmentId, tag: { ...tag }, error: "" };
  }

  confirmDeleteTag(): void {
    const dialog = this.deleteTagDialog;
    const client = this.client;
    const expectedObjectId = dialog?.tag.objectId;
    if (!dialog || !client || !expectedObjectId || !this.canDeleteTag || dialog.repositoryId !== this.activeRepositoryId || dialog.environmentId !== this.workspaceState?.environmentId) return;
    const name = tagName(dialog.tag);
    this.requestGitAction({
      kind: "deleteTag",
      label: "Deleting tag",
      successMessage: `Deleted tag ${name}`,
      action: (repositoryId) => client.deleteTag({ repositoryId, name, expectedObjectId }),
      onApplied: () => { if (this.deleteTagDialog === dialog) this.deleteTagDialog = null; },
      onFailed: (error) => {
        if (this.deleteTagDialog !== dialog) return false;
        dialog.error = summarizeGitError(error);
        return true;
      },
    });
  }

  openDeleteBranchDialog(branch: CommitRef): void {
    const repositoryId = this.activeRepositoryId;
    const environmentId = this.workspaceState?.environmentId;
    if (!repositoryId || !environmentId || !this.canDeleteBranch || branch.refType !== "localBranch") return;
    if (this.snapshot?.status.currentBranch === branch.shortName || this.snapshot?.worktrees.some((worktree) => worktree.branch === branch.shortName)) return;
    this.deleteBranchDialog = { repositoryId, environmentId, branch, force: false, error: "" };
  }

  confirmDeleteBranch(): void {
    const dialog = this.deleteBranchDialog;
    const client = this.client;
    if (!dialog || !client || this.gitActionPending || dialog.repositoryId !== this.activeRepositoryId || dialog.environmentId !== this.workspaceState?.environmentId) return;
    this.deleteBranchDialog = null;
    this.requestGitAction({
      kind: "deleteBranch",
      label: "Deleting branch",
      successMessage: `Deleted branch ${dialog.branch.shortName}`,
      action: (repositoryId) => client.deleteBranch({ repositoryId, name: dialog.branch.shortName, expectedTarget: dialog.branch.target, force: dialog.force }),
      onFailed: (error) => this.offerUnmergedDeletionReview(error, dialog, () => {
        this.deleteBranchDialog = { ...dialog, force: true, error: "" };
      }),
    });
  }

  openRenameWorktreeBranchDialog(worktree: WorktreeInfo): void {
    const branch = this.snapshot?.refs.find((ref) => ref.refType === "localBranch" && ref.shortName === worktree.branch);
    if (branch) this.openRenameBranchDialog(branch);
  }

  openRemoveWorktreeDialog(worktree: WorktreeInfo, deleteBranch: boolean): void {
    const repositoryId = this.activeRepositoryId;
    const environmentId = this.workspaceState?.environmentId;
    if (!repositoryId || !environmentId || !this.canRemoveWorktree || !removableWorktree(worktree)) return;
    if (deleteBranch && (!worktree.branch || !this.canDeleteBranch)) return;
    this.removeWorktreeDialog = { repositoryId, environmentId, worktree, deleteBranch, forceBranchDeletion: false, error: "" };
  }

  confirmRemoveWorktree(): void {
    const dialog = this.removeWorktreeDialog;
    const client = this.client;
    const workspace = this.workspace;
    if (!dialog || !client || !workspace || this.gitActionPending || dialog.repositoryId !== this.activeRepositoryId || dialog.environmentId !== this.workspaceState?.environmentId) return;
    this.removeWorktreeDialog = null;
    this.requestGitAction({
      kind: "removeWorktree",
      label: "Removing worktree",
      notifySuccess: false,
      action: (repositoryId) => client.removeWorktree({
        repositoryId,
        worktreePath: dialog.worktree.path,
        expectedHead: dialog.worktree.headOid!,
        expectedBranch: dialog.worktree.branch,
        deleteBranch: dialog.deleteBranch,
        forceBranchDeletion: dialog.forceBranchDeletion,
      }),
      onApplied: async (result) => {
        const outcome = result as GitWorktreeRemoveResult | undefined;
        if (!outcome) return;
        for (const id of outcome.removedRepositoryIds) {
          delete this.commitDrafts[`${dialog.environmentId}:${id}`];
          if (this.workspace === workspace) this.repositoryCatalog = this.repositoryCatalog.filter((repo) => repo.id !== id);
          if (this.externalTabs && this.applicationWorkspace) {
            const tab = this.applicationWorkspace.state.tabs.find((item) => item.target.environmentId === dialog.environmentId && item.target.repositoryId === id);
            if (tab) await this.applicationWorkspace.closeIfMatches(tab.tabId, { environmentId: dialog.environmentId, repositoryId: id });
            void this.runtime.refreshEnvironmentCatalog(dialog.environmentId);
          } else {
            await workspace.forgetRepository(id);
          }
        }
      },
      onSucceeded: (result) => {
        const outcome = result as GitWorktreeRemoveResult;
        if (outcome.warning) toast.warning("Worktree removal needs attention", { description: outcome.warning });
        else toast.success(outcome.branchDeleted ? "Worktree and branch removed" : "Worktree removed");
      },
      onFailed: (error) => this.offerUnmergedDeletionReview(error, dialog, () => {
        this.removeWorktreeDialog = { ...dialog, forceBranchDeletion: true, error: "" };
      }),
    });
  }

  private offerUnmergedDeletionReview(
    error: unknown,
    context: { repositoryId: string; environmentId: string },
    onReview: () => void,
  ): boolean {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "branch_not_merged") return false;
    toast.warning("Branch has unmerged commits", {
      description: "Nothing was removed. Review the warning before choosing Delete anyway.",
      duration: 15000,
      action: {
        label: "Review deletion",
        onClick: () => {
          if (context.repositoryId !== this.activeRepositoryId || context.environmentId !== this.workspaceState?.environmentId) {
            toast.error("Open the original repository to review deletion.");
          } else if (this.gitActionPending || this.gitNameDialogKind || this.deleteBranchDialog || this.deleteTagDialog || this.tagFetchReview || this.removeWorktreeDialog || this.discardDialog || this.repositoryPathDialogOpen) {
            toast.error("Finish the current action before reviewing deletion.");
          } else {
            onReview();
          }
        },
      },
    });
    return true;
  }

  popStash(): void {
    const latest = this.snapshot?.stashes[0];
    if (latest && this.canPopStash) this.openStashAction("pop", latest);
  }

  private supportsStash(action: keyof typeof stashMethods): boolean {
    return !this.gitActionPending && this.client?.serverWelcome.environment_id === this.connectionEnvironmentId &&
      (this.client?.serverWelcome.capabilities.includes(stashMethods[action]) ?? false);
  }

  openSelectedStash(source: "staged" | "unstaged", files: ChangedFile[]): void {
    const environmentId = this.workspaceState?.environmentId;
    const repositoryId = this.activeRepositoryId;
    const paths = selectedStashPaths(files);
    if (!environmentId || !repositoryId || !paths.length || !this.supportsStash("selected")) return;
    this.stashReview = { action: "selected", context: { environmentId, repositoryId }, source, paths };
  }

  openStashAction(action: StashAction, stash: StashInfo): void {
    const environmentId = this.workspaceState?.environmentId;
    const repositoryId = this.activeRepositoryId;
    if (!environmentId || !repositoryId || !this.supportsStash(action) || !reconcileSelectedStash(stash, this.snapshot?.stashes ?? [])) return;
    const context = captureStashActionContext(environmentId, repositoryId, stash);
    if (action === "apply") {
      void this.executeStash(action, context, (client) => client.stashApply({ repositoryId, target: { ...context.target } }));
    } else {
      this.stashReview = { action, context, stash: { ...stash }, destination: this.snapshot?.status.currentBranch ?? "Detached HEAD", destinationHead: this.snapshot?.status.headOid ?? null };
    }
  }

  submitStashReview(value: string): void {
    const review = this.stashReview;
    if (!review || this.gitActionPending) return;
    this.stashReview = null;
    if (review.action !== "selected" && review.action !== "drop" &&
      (review.destination !== (this.snapshot?.status.currentBranch ?? "Detached HEAD") || review.destinationHead !== (this.snapshot?.status.headOid ?? null))) {
      toast.error("The destination changed", { description: "Open the stash action again to review the current branch." });
      return;
    }
    const { repositoryId } = review.context;
    if (review.action === "selected") {
      const paths = [...review.paths];
      if (!paths.length) return;
      void this.executeStash("selected", review.context, (client) => client.stashPushSelected({ repositoryId, source: review.source, paths, ...(value.trim() ? { message: value.trim() } : {}) }));
    } else {
      const params = { repositoryId, target: { ...review.context.target } };
      void this.executeStash(review.action, review.context, (client) => review.action === "branch"
        ? client.stashBranch({ ...params, name: value.trim() })
        : review.action === "pop" ? client.stashPopTarget(params) : client.stashDrop(params), value.trim());
    }
  }

  private async executeStash(
    action: StashAction | "selected",
    context: { environmentId: string; repositoryId: string; target?: { selector: string; expectedOid: string } },
    mutate: (client: GitGuiClient) => Promise<StashReceipt>,
    branchName = "",
  ): Promise<void> {
    // Resolve the current projected session once at execution, then retain that
    // environment's client/workspace across every await. Never route late work
    // through this.client after an environment switch.
    const runtime = this.runtime.state;
    const client = this.externalTabs ? this.client : runtime.client;
    const workspace = this.externalTabs ? this.workspace : runtime.workspace;
    if (!client || !workspace || this.gitActionPending ||
      client.serverWelcome.environment_id !== context.environmentId ||
      (!this.externalTabs && runtime.registry.selectedEnvironmentId && runtime.registry.selectedEnvironmentId !== context.environmentId) ||
      !stashContextIsCurrent(context, this.workspaceState?.environmentId, this.activeRepositoryId, this.snapshot?.stashes ?? [])) {
      toast.error("Stash review is no longer current", { description: "Open the action again in the original repository." });
      return;
    }
    if (!client.serverWelcome.capabilities.includes(stashMethods[action])) {
      toast.error("This server does not support that stash action");
      return;
    }
    const refresh = () => this.refreshAfterMutation(workspace, context.repositoryId);
    // Linked worktrees share refs/stash. Use only server-reported membership
    // within this environment, never path/name guesses across hosts.
    const sourceRepo = this.openRepos.find((repo) => repo.id === context.repositoryId);
    const stashRoots = new Set([sourceRepo?.root, ...(sourceRepo?.snapshot?.worktrees.map((entry) => entry.path) ?? [])]);
    const retryRefresh = async () => {
      const current = this.runtime.state;
      const scoped = this.externalTabs ? this.runtime.getEnvironmentWorkspace(context.environmentId) : null;
      const retryWorkspace = this.externalTabs ? scoped?.workspace : current.workspace;
      if (!retryWorkspace || (!this.externalTabs && (current.client?.serverWelcome.environment_id !== context.environmentId || current.registry.selectedEnvironmentId !== context.environmentId))) {
        throw new Error("Select and reconnect to the original environment before refreshing this repository.");
      }
      await this.refreshAfterMutation(retryWorkspace, context.repositoryId);
    };
    const submittedAction = this.beginGitAction(context, action === "pop" ? "stashPop" : "stash", action === "selected" ? "Stashing selected changes" : "Updating stash");
    const request = action === "selected" ? { action, repositoryId: context.repositoryId } : action === "branch"
      ? { action, repositoryId: context.repositoryId, target: { ...context.target! }, name: branchName }
      : { action, repositoryId: context.repositoryId, target: { ...context.target! } };
    const result = await performStashOperation(request, () => mutate(client), refresh, (receipt) => {
      if (action !== "selected" && "stashState" in receipt && receipt.stashState === "removed") {
        const removedIndex = stashSelectorIndex(receipt.target.selector);
        const invalidate = (repo: WorkspaceRepo): WorkspaceRepo => {
          const selected = repo.selectedGraphItem;
          const sharesStashes = repo.id === context.repositoryId || [...stashRoots].some((root) => root && sameHostPath(root, repo.root)) ||
            (sourceRepo && repo.snapshot?.worktrees.some((entry) => sameHostPath(entry.path, sourceRepo.root)));
          if (!sharesStashes || selected?.type !== "stash") return repo;
          const selectedIndex = stashSelectorIndex(selected.stash.selector);
          // Removal shifts every older selector, even when its OID is unchanged
          // or duplicates another entry. Never follow an entry by OID alone.
          const shifted = removedIndex !== null && selectedIndex !== null && selectedIndex >= removedIndex;
          const removed = selected.stash.selector === receipt.target.selector && selected.stash.hash === receipt.target.expectedOid;
          return shifted || removed
            ? { ...repo, selectionInitialized: true, selectedGraphItem: null, selectedFile: null, selectedFileSource: null }
            : repo;
        };
        if (this.externalTabs) {
          for (const [key, repo] of this.repositorySelections) {
            if (key === scopedRepositoryKey({ environmentId: context.environmentId, repositoryId: repo.id })) this.repositorySelections.set(key, invalidate(repo));
          }
        }
        if (this.workspaceState?.environmentId === context.environmentId) this.openRepos = this.openRepos.map(invalidate);
      }
    });
    this.releaseGitAction(submittedAction);
    if (result.receipt && (result.notice.conflicts || this.hasUnmergedFiles(context.repositoryId, workspace.state)) &&
      this.workspaceState?.environmentId === context.environmentId && this.activeRepositoryId === context.repositoryId && (this.externalTabs || this.runtime.state.registry.selectedEnvironmentId === context.environmentId)) this.selectChanges();
    const { tone, title, description } = result.notice;
    toast[tone](result.refreshError ? `${title}; refresh failed` : title, {
      description: result.refreshError ? `${description} ${summarizeGitError(result.refreshError)}` : description,
      ...(result.refreshError ? {
        action: {
          label: "Retry refresh",
          onClick: () => { void retryRefresh().catch((error) => toast.error("Refresh failed", { description: summarizeGitError(error) })); },
        },
      } : {}),
    });
    this.runNextGitAction(context);
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

function stashSelectorIndex(selector: string): number | null {
  const match = /^stash@\{(0|[1-9]\d*)\}$/.exec(selector);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isSafeInteger(index) ? index : null;
}

function isMutationSnapshotResult(
  value: unknown,
): value is { repository: RepositorySummary; snapshot: RepositorySnapshot } {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Partial<{ repository: RepositorySummary; snapshot: RepositorySnapshot }>;
  return Boolean(result.repository && result.snapshot);
}
