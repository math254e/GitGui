/**
 * The agreement between the URL and the workspace.
 *
 * The URL owns what is on screen. The workspace owns which repositories are
 * open. Route decisions and a small entry controller keep those responsibilities
 * separate, with tab activation supplied by an adapter.
 */
import { getContext, setContext } from "svelte";
import { repositoryPath, scopedRepositoryPath, type RepositoryRouteRequest } from "./routes";
import type { ScopedRepositoryRef } from "@gitgui/client-runtime/workspace";
import { sameRepository, scopedRepositoryKey } from "@gitgui/client-runtime/workspace";
import type { WorkspaceStore } from "./workspace-store.svelte";

/** Presentation only. An adapter can supply a scoped projection instead of a store. */
export type RepositoryPageModel = Pick<WorkspaceStore,
  | "integrationState" | "integrationReview" | "integrationError" | "canIntegrate" | "canStartIntegration" | "canRebaseCommit"
  | "refreshIntegration" | "openIntegrationReview" | "confirmIntegration" | "recoverIntegration"
  | "integrationRecoveryDialog" | "requestIntegrationRecovery" | "confirmIntegrationRecovery"
  | "rewritePushReview" | "rewritePushReviewPending" | "openRewritePushReview" | "confirmRewritePush"
  | "activeCommitDraft"
  | "activeRepository"
  | "activeRepositoryId"
  | "activeEnvironmentGeneration"
  | "repositoryAvailability"
  | "retryActiveRepository"
  | "amendInfo"
  | "amendLoading"
  | "applySelectedHunks"
  | "beginCreateRepository"
  | "canCheckoutTag"
  | "canCreateTag"
  | "canDeleteBranch"
  | "canDeleteTag"
  | "canPopStash"
  | "canPushTag"
  | "canRemoveWorktree"
  | "canRenameBranch"
  | "changeCommitDraft"
  | "changesSelected"
  | "checkoutTag"
  | "chooseRepository"
  | "client"
  | "closeDiff"
  | "commitChanges"
  | "commitPending"
  | "compareCommitToWorkingTree"
  | "comparingCommitToWorkingTree"
  | "connectionError"
  | "fetchRepository"
  | "finishScrollToCommit"
  | "gitAction"
  | "gitActionPending"
  | "graphScrollTopFor"
  | "graphSnapshot"
  | "homeRepositories"
  | "isDesktop"
  | "largeScreen"
  | "largeScreenPanes"
  | "loadTagDetails"
  | "loading"
  | "openBranchDialog"
  | "openDeleteBranchDialog"
  | "openDeleteTagDialog"
  | "openDiscard"
  | "openRemoveWorktreeDialog"
  | "openRenameBranchDialog"
  | "openRenameWorktreeBranchDialog"
  | "openRepository"
  | "openSelectedStash"
  | "openStashAction"
  | "openStashDialog"
  | "openTagDialog"
  | "openWorktreeInNewTab"
  | "popStash"
  | "pullRepository"
  | "pushRepository"
  | "pushTag"
  | "rememberGraphScrollTop"
  | "removeRepository"
  | "resizePane"
  | "retryLocalConnection"
  | "scrollToCommit"
  | "selectChangePaths"
  | "selectChanges"
  | "selectCommit"
  | "selectFile"
  | "selectRef"
  | "selectStash"
  | "selectedChangePaths"
  | "selectedChangeSource"
  | "selectedCommit"
  | "selectedFile"
  | "selectedFileSource"
  | "selectedStash"
  | "sidebarStateKey"
  | "snapshot"
  | "stageActionRunning"
  | "stageAll"
  | "stageFile"
  | "stagePaths"
  | "stageQueueLabel"
  | "stageQueueWaiting"
  | "startError"
  | "stashCapabilities"
  | "stashContextKey"
  | "stashReview"
  | "submitStashReview"
  | "switchBranch"
  | "switchWorktree"
  | "toggleAmend"
  | "toggleGraphRefs"
  | "unstageAll"
  | "unstageFile"
  | "unstagePaths"
  | "visibleGraphRefKeys"
  | "workspaceState"
> & Partial<Pick<WorkspaceStore, "activeRepositoryEnvironments" | "activeApplicationTab" | "switchScopedRepository" | "openScopedRepository" | "repositoryDisconnected">>;

export interface RepositoryRouteCandidate {
  readonly target: ScopedRepositoryRef;
  readonly environmentLabel: string;
  readonly path: string;
}

export interface RepositoryRouteSnapshot {
  /** Application tab/registration metadata has restored; network hydration is not required. */
  readonly ready: boolean;
  readonly environmentIds: readonly string[];
  /** False while an uncached known catalog could still make an old ID ambiguous. */
  readonly legacyCatalogsReady: boolean;
  readonly candidates: readonly RepositoryRouteCandidate[];
  /** Saved pre-migration selection, read once, never the currently displayed tab's environment. */
  readonly legacySelectedEnvironmentId?: string;
  readonly openTargets: readonly ScopedRepositoryRef[];
  readonly activeTarget: ScopedRepositoryRef | null;
  /** Must describe activeTarget, including its scoped clients, actions and view state. */
  readonly view: RepositoryPageModel | null;
}

/**
 * Provide once beside the application tab coordinator. snapshot must be reactive.
 * activate selects an existing scoped tab or opens through that coordinator,
 * without navigating. Check signal before publishing/persisting a prepared tab;
 * abort means a newer route won, its tab closed, its environment was removed,
 * or unmount. The coordinator also guards its own navigation revision/reservations.
 * Closing publishes openTargets/activeTarget; this route replaces its URL.
 * See routes/repo/INTEGRATION.md for root integration and transition limits.
 */
export interface RepositoryRouteAdapter {
  readonly snapshot: RepositoryRouteSnapshot;
  activate(target: ScopedRepositoryRef, options: { readonly signal: AbortSignal }): Promise<void>;
}

const REPOSITORY_ROUTE_ADAPTER = Symbol("gitgui.repository-route-adapter");

export function provideRepositoryRouteAdapter(adapter: RepositoryRouteAdapter): void {
  setContext(REPOSITORY_ROUTE_ADAPTER, adapter);
}

export function useRepositoryRouteAdapter(): RepositoryRouteAdapter | undefined {
  return getContext<RepositoryRouteAdapter | undefined>(REPOSITORY_ROUTE_ADAPTER);
}

export type RepositoryRouteState =
  | { kind: "loading" }
  | { kind: "ready"; target: ScopedRepositoryRef }
  | { kind: "ambiguous"; candidates: readonly RepositoryRouteCandidate[] }
  | { kind: "missing"; message: string }
  | { kind: "closed" }
  | { kind: "error"; message: string };

export function resolveClosedScopedRepositoryTarget(target: ScopedRepositoryRef | null): string {
  return target ? scopedRepositoryPath(target.environmentId, target.repositoryId) : "/";
}

/** One route entry, not one effect run: closing a tab must never open it again. */
export class RepositoryRouteController {
  private entryKey: string | undefined;
  private request: RepositoryRouteRequest | null = null;
  private snapshot: RepositoryRouteSnapshot | null = null;
  private target: ScopedRepositoryRef | null = null;
  private activation: AbortController | null = null;
  private handled = false;
  private sawOpen = false;
  private closed = false;
  private error: string | null = null;
  private disposed = false;

  constructor(
    private readonly adapter: Pick<RepositoryRouteAdapter, "activate">,
    private readonly onState: (state: RepositoryRouteState) => void,
    private readonly replaceClosedRoute: (target: ScopedRepositoryRef | null) => void,
  ) {}

  update(request: RepositoryRouteRequest | null, snapshot: RepositoryRouteSnapshot): void {
    if (this.disposed) return;
    const key = !request ? "invalid" : request.kind === "legacy"
      ? JSON.stringify(["legacy", request.repositoryId])
      : "scoped:" + scopedRepositoryKey(request.target);
    if (key !== this.entryKey) {
      this.activation?.abort();
      this.entryKey = key;
      this.target = null;
      this.handled = false;
      this.sawOpen = false;
      this.closed = false;
      this.error = null;
    }
    this.request = request;
    this.snapshot = snapshot;
    this.reconcile();
  }

  retry(): void {
    if (this.disposed || this.closed) return;
    this.activation?.abort();
    this.handled = false;
    this.error = null;
    this.reconcile();
  }

  dispose(): void {
    this.disposed = true;
    this.activation?.abort();
  }

  private reconcile(): void {
    const snapshot = this.snapshot;
    const request = this.request;
    if (!snapshot || !request) {
      this.onState({ kind: "missing", message: "Invalid repository link." });
      return;
    }
    if (this.closed) {
      this.onState({ kind: "closed" });
      return;
    }
    if (!snapshot.ready) {
      this.onState({ kind: "loading" });
      return;
    }
    if (!this.target) {
      if (request.kind === "scoped") {
        this.target = { ...request.target };
      } else {
        const resolution = resolveLegacyRepositoryTarget(request.repositoryId,
          snapshot.candidates.map((candidate) => candidate.target), snapshot.legacySelectedEnvironmentId);
        // A saved mapping is authoritative only when its actual target is known.
        const saved = resolution.kind === "found" && resolution.target.environmentId === snapshot.legacySelectedEnvironmentId;
        if (!saved && !snapshot.legacyCatalogsReady && resolution.kind !== "ambiguous") {
          this.onState({ kind: "loading" });
          return;
        }
        if (resolution.kind === "ambiguous") {
          this.onState({ kind: "ambiguous", candidates: resolution.targets.map((target) =>
            snapshot.candidates.find((candidate) => sameRepository(candidate.target, target))!) });
          return;
        }
        if (resolution.kind === "missing") {
          this.onState({ kind: "missing", message: "Repository was not found in the known environments." });
          return;
        }
        this.target = { ...resolution.target };
      }
    }
    const target = this.target;
    const isOpen = snapshot.openTargets.some((candidate) => sameRepository(candidate, target));
    if (!isOpen && this.sawOpen) {
      this.closed = true;
      this.activation?.abort();
      this.onState({ kind: "closed" });
      this.replaceClosedRoute(snapshot.activeTarget);
      return;
    }
    if (!snapshot.environmentIds.includes(target.environmentId)) {
      this.activation?.abort();
      // Removal of a displayed environment and durable tab cleanup arrive as
      // separate updates. Wait for the tab owner to publish the surviving tab.
      this.onState(this.sawOpen && isOpen ? { kind: "loading" } : { kind: "missing", message: "This environment is no longer registered." });
      return;
    }
    this.sawOpen ||= isOpen;
    if (this.error) {
      this.onState({ kind: "error", message: this.error });
      return;
    }
    const active = snapshot.activeTarget && sameRepository(snapshot.activeTarget, target);
    this.onState(active && snapshot.view ? { kind: "ready", target } : { kind: "loading" });
    if (this.handled) return;
    this.handled = true;
    if (isOpen && active) return;
    const activation = new AbortController();
    this.activation = activation;
    // Promise.resolve also catches a synchronously throwing adapter.
    void Promise.resolve().then(() => {
      if (!activation.signal.aborted) return this.adapter.activate(target, { signal: activation.signal });
    }).catch((error: unknown) => {
      if (this.disposed || activation.signal.aborted) return;
      this.error = error instanceof Error ? error.message : "Could not open repository.";
      this.reconcile();
    });
  }
}

/** Resolve old links without guessing when the same server-local ID exists on multiple hosts. */
export function resolveLegacyRepositoryTarget(
  repositoryId: string,
  candidates: readonly ScopedRepositoryRef[],
  legacySelectedEnvironmentId?: string,
): { kind: "found"; target: ScopedRepositoryRef } | { kind: "ambiguous"; targets: ScopedRepositoryRef[] } | { kind: "missing" } {
  const matches = candidates.filter((candidate) => candidate.repositoryId === repositoryId);
  const unique = [...new Map(matches.map((candidate) => [candidate.environmentId, candidate])).values()];
  const selected = legacySelectedEnvironmentId && unique.find((candidate) => candidate.environmentId === legacySelectedEnvironmentId);
  if (selected) return { kind: "found", target: selected };
  if (unique.length === 1) return { kind: "found", target: unique[0] };
  if (unique.length > 1) return { kind: "ambiguous", targets: unique };
  return { kind: "missing" };
}

/** What the repository route asks the workspace to do. */
export type RouteIntent =
  | { kind: "none" }
  | { kind: "select"; repositoryId: string }
  | { kind: "open"; repositoryId: string };

/**
 * Resolve the repository the URL points at.
 *
 * A repository that is already open only needs to become the active one. A
 * repository that is not open has to be opened first.
 */
export function resolveRouteIntent(input: {
  readonly routedRepositoryId: string | null;
  readonly openRepositoryIds: readonly string[];
  readonly activeRepositoryId: string | null;
}): RouteIntent {
  const repositoryId = input.routedRepositoryId;
  if (!repositoryId) return { kind: "none" };
  if (!input.openRepositoryIds.includes(repositoryId)) {
    return { kind: "open", repositoryId };
  }
  if (input.activeRepositoryId !== repositoryId) {
    return { kind: "select", repositoryId };
  }
  return { kind: "none" };
}

/**
 * Where to go when the routed repository is closed.
 *
 * The next open repository takes the URL, or the repositories home page when
 * the closed tab was the last one.
 */
export function resolveClosedRepositoryTarget(activeRepositoryId: string | null): string {
  return activeRepositoryId ? repositoryPath(activeRepositoryId) : "/";
}
