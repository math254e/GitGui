/**
 * A promise-based view of the Effect RPC session.
 *
 * The connection runtime is Effect-native. The Svelte workspace layer still
 * speaks promises, so this module is the explicit bridge between the two:
 * every method is one `Effect.runPromise` over the session's `call`.
 *
 * It is not part of the vendored T3 Code runtime. T3 Code's React layer
 * consumes Effect directly.
 */
import type {
  CommitFileDiffParams,
  CommitFilesParams,
  CommitWorkingTreeFilesParams,
  CommitWorkingTreeFileDiffParams,
  FileDiffResult,
  GitAmendParams,
  GitApplyHunksParams,
  GitBranchCreateParams,
  GitBranchRenameParams,
  GitBranchDeleteParams,
  GitWorktreeRemoveParams,
  GitBranchSwitchParams,
  GitCommitParams,
  GitDiscardParams,
  GitHunkPreviewParams,
  GitStashPushParams,
  OrderedEventEnvelope,
  PrefetchCommitDiffsParams,
  RepositoriesCreateParams,
  RepositoryGraphParams,
  ServerInfo,
  ServerStatus,
  WorkingTreeFileDiffParams,
  WelcomeMessage,
} from "@gitgui/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { GitGuiClientError } from "./errors.ts";
import { OrderedEventBus, type SequenceGapListener } from "./events.ts";
import {
  GitGuiRpcError,
  type GitGuiRpcMethod,
  type GitGuiRpcMethods,
  type GitGuiRpcProtocolClient,
} from "./protocol.ts";
import type { SequenceGap } from "./session.ts";

export type Unsubscribe = () => void;
export type StateListener = (change: { previous: string; current: string; error?: Error }) => void;

export interface GitGuiClientOptions {
  readonly client: GitGuiRpcProtocolClient;
  readonly welcome: WelcomeMessage;
  /**
   * The holes the transport saw in the server's event sequence.
   *
   * The transport owns the sequence, so it owns the gap detection too.
   */
  readonly sequenceGaps?: Stream.Stream<SequenceGap, GitGuiRpcError>;
  /**
   * Runs one effect. The default runs it on the global runtime, which is
   * enough because the session's calls need no services.
   */
  readonly run?: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
}

const toClientError = (error: unknown): GitGuiClientError => {
  if (error instanceof GitGuiClientError) return error;
  if (error instanceof GitGuiRpcError) {
    return new GitGuiClientError(error.message, {
      code: error.code,
      ...(error.details === undefined ? {} : { details: error.details as never }),
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    });
  }
  return new GitGuiClientError(error instanceof Error ? error.message : String(error), {
    code: "client_error",
  });
};

/**
 * A browser-safe client for one GitGui host, over an Effect RPC session.
 */
export class GitGuiClient {
  private readonly client: GitGuiRpcProtocolClient;
  private readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  private readonly eventBus = new OrderedEventBus();
  private readonly welcome: WelcomeMessage;
  private readonly readers: Array<Fiber.Fiber<void, GitGuiRpcError>> = [];

  constructor(options: GitGuiClientOptions) {
    this.client = options.client;
    this.welcome = options.welcome;
    this.run = options.run ?? ((effect) => Effect.runPromise(effect));
    this.readers.push(Effect.runFork(
      Stream.runForEach(this.client.events, (event) => Effect.sync(() => this.eventBus.accept(event))),
    ));
    if (options.sequenceGaps !== undefined) {
      this.readers.push(Effect.runFork(
        Stream.runForEach(options.sequenceGaps, (gap) =>
          Effect.sync(() => this.eventBus.reportGap(gap)),
        ),
      ));
    }
  }

  /** Releases readers when the selected workspace stops using this session. */
  dispose(): void {
    for (const reader of this.readers.splice(0)) Effect.runFork(Fiber.interrupt(reader));
  }

  get serverWelcome(): WelcomeMessage {
    return this.welcome;
  }

  get lastEventSequence(): number | undefined {
    return this.eventBus.sequence;
  }

  on(eventName: string, listener: (event: OrderedEventEnvelope) => void): Unsubscribe {
    return this.eventBus.on(eventName, listener);
  }

  onSequenceGap(listener: SequenceGapListener): Unsubscribe {
    return this.eventBus.onSequenceGap(listener);
  }

  private call<K extends GitGuiRpcMethod>(
    method: K,
    input: GitGuiRpcMethods[K]["input"],
    signal?: AbortSignal,
  ): Promise<GitGuiRpcMethods[K]["output"]> {
    // Keep interruption inside the Effect call, so its pending-entry finalizer
    // runs and informs the server. A Promise.race would leave that call alive.
    if (signal?.aborted) {
      return Promise.reject(new GitGuiClientError("The read request was cancelled.", { code: "request_cancelled" }));
    }
    const call = this.client.call(method, input);
    const result = signal === undefined ? call : Effect.raceFirst(
      call,
      Effect.callback<never, GitGuiRpcError>((resume) => {
        const abort = () => resume(Effect.fail(new GitGuiRpcError({
          code: "request_cancelled", message: "The read request was cancelled.",
        })));
        if (signal.aborted) { abort(); return; }
        signal.addEventListener("abort", abort, { once: true });
        return Effect.sync(() => signal.removeEventListener("abort", abort));
      }),
    );
    return this.run(result).catch((error) => {
      throw toClientError(error);
    });
  }

  getServerInfo(): Promise<ServerInfo> {
    return this.call("server.get_info", {});
  }

  getServerStatus(): Promise<ServerStatus> {
    return this.call("server.get_status", {});
  }

  async listRepositories() {
    const result = await this.call("repositories.list", {});
    return result.repositories;
  }

  openRepository(path: string) {
    if (!path.trim()) throw new TypeError("Repository path cannot be empty");
    return this.call("repositories.open", { path });
  }

  createRepository(
    parentPath: string,
    name: string,
    options: { initialBranch?: string; initializeLfs?: boolean } = {},
  ) {
    if (!parentPath.trim()) throw new TypeError("Repository parent path cannot be empty");
    if (!name.trim()) throw new TypeError("Repository name cannot be empty");
    const params: RepositoriesCreateParams = {
      parentPath,
      name,
      ...(options.initialBranch?.trim() ? { initialBranch: options.initialBranch.trim() } : {}),
      initializeLfs: options.initializeLfs ?? false,
    };
    return this.call("repositories.create", params);
  }

  removeRepository(repositoryId: string) {
    return this.call("repositories.remove", { repositoryId: assertRepositoryId(repositoryId) });
  }

  getRepositorySnapshot(repositoryId: string) {
    return this.call("repositories.get_snapshot", {
      repositoryId: assertRepositoryId(repositoryId),
    });
  }

  getRepositoryGraph(params: RepositoryGraphParams) {
    return this.call("repositories.get_graph", {
      ...params,
      repositoryId: assertRepositoryId(params.repositoryId),
      targetCommits: uniqueCommitHashes(params.targetCommits),
    });
  }

  refreshRepositories(repositoryIds: string[]) {
    return this.call("repositories.refresh", {
      repositoryIds: uniqueRepositoryIds(repositoryIds),
    });
  }

  getGitStatus(repositoryId: string) {
    return this.call("git.status", { repositoryId: assertRepositoryId(repositoryId) });
  }

  stage(repositoryId: string, paths: string[] = []) {
    return this.call("git.stage", { repositoryId: assertRepositoryId(repositoryId), paths: [...paths] });
  }

  unstage(repositoryId: string, paths: string[] = []) {
    return this.call("git.unstage", {
      repositoryId: assertRepositoryId(repositoryId),
      paths: [...paths],
    });
  }

  commit(params: GitCommitParams) {
    return this.call("git.commit", {
      ...params,
      repositoryId: assertRepositoryId(params.repositoryId),
    });
  }

  getCommitFiles(repositoryId: string, commitHash: string) {
    const params: CommitFilesParams = {
      repositoryId: assertRepositoryId(repositoryId),
      commitHash,
    };
    return this.call("git.commit_files", params);
  }

  getCommitWorkingTreeFiles(repositoryId: string, commitHash: string) {
    const params: CommitWorkingTreeFilesParams = { repositoryId: assertRepositoryId(repositoryId), commitHash };
    return this.call("git.commit_working_tree_files", params);
  }

  getCommitWorkingTreeFileDiff(params: CommitWorkingTreeFileDiffParams, signal?: AbortSignal) {
    return this.call("git.commit_working_tree_file_diff", {
      ...params,
      repositoryId: assertRepositoryId(params.repositoryId),
    }, signal);
  }

  getCommitFileDiff(params: CommitFileDiffParams, signal?: AbortSignal) {
    return this.call("git.commit_file_diff", {
      ...params,
      repositoryId: assertRepositoryId(params.repositoryId),
    }, signal);
  }

  getWorkingTreeFileDiff(params: WorkingTreeFileDiffParams, signal?: AbortSignal): Promise<FileDiffResult> {
    return this.call("git.working_tree_file_diff", {
      ...params,
      repositoryId: assertRepositoryId(params.repositoryId),
    }, signal);
  }

  prefetchCommitFiles(repositoryId: string, commitHashes: string[]) {
    return this.call("git.prefetch_commit_files", {
      repositoryId: assertRepositoryId(repositoryId),
      commitHashes: uniqueCommitHashes(commitHashes),
    });
  }

  prefetchCommitDiffs(params: PrefetchCommitDiffsParams) {
    return this.call("git.prefetch_commit_diffs", {
      ...params,
      repositoryId: assertRepositoryId(params.repositoryId),
    });
  }

  getHunkPreview(params: GitHunkPreviewParams, signal?: AbortSignal) {
    return this.call("git.hunk_preview", {
      ...params,
      repositoryId: assertRepositoryId(params.repositoryId),
    }, signal);
  }

  applyHunks(params: GitApplyHunksParams) {
    return this.call("git.apply_hunks", {
      ...params,
      repositoryId: assertRepositoryId(params.repositoryId),
    });
  }

  previewDiscard(repositoryId: string, paths: string[]) {
    return this.call("git.discard_preview", {
      repositoryId: assertRepositoryId(repositoryId),
      paths,
    });
  }

  discard(params: GitDiscardParams) {
    return this.call("git.discard", {
      ...params,
      repositoryId: assertRepositoryId(params.repositoryId),
    });
  }

  getAmendInfo(repositoryId: string) {
    return this.call("git.amend_info", {
      repositoryId: assertRepositoryId(repositoryId),
    });
  }

  amend(params: GitAmendParams) {
    return this.call("git.amend", {
      ...params,
      repositoryId: assertRepositoryId(params.repositoryId),
    });
  }

  fetch(repositoryId: string) {
    return this.call("git.fetch", { repositoryId: assertRepositoryId(repositoryId) });
  }

  pull(repositoryId: string) {
    return this.call("git.pull", { repositoryId: assertRepositoryId(repositoryId) });
  }

  push(repositoryId: string) {
    return this.call("git.push", { repositoryId: assertRepositoryId(repositoryId) });
  }

  listBranches(repositoryId: string) {
    return this.call("git.branch.list", { repositoryId: assertRepositoryId(repositoryId) });
  }

  createBranch(params: GitBranchCreateParams) {
    return this.call("git.branch.create", {
      ...params,
      repositoryId: assertRepositoryId(params.repositoryId),
    });
  }

  switchBranch(params: GitBranchSwitchParams) {
    return this.call("git.branch.switch", {
      ...params,
      repositoryId: assertRepositoryId(params.repositoryId),
    });
  }

  renameBranch(params: GitBranchRenameParams) {
    return this.call("git.branch.rename", { ...params, repositoryId: assertRepositoryId(params.repositoryId) });
  }

  deleteBranch(params: GitBranchDeleteParams) {
    return this.call("git.branch.delete", { ...params, repositoryId: assertRepositoryId(params.repositoryId) });
  }

  removeWorktree(params: GitWorktreeRemoveParams) {
    return this.call("git.worktree.remove", { ...params, repositoryId: assertRepositoryId(params.repositoryId) });
  }

  stashPush(params: GitStashPushParams) {
    return this.call("git.stash.push", {
      ...params,
      includeUntracked: params.includeUntracked ?? true,
      repositoryId: assertRepositoryId(params.repositoryId),
    });
  }

  stashPop(repositoryId: string) {
    return this.call("git.stash.pop", { repositoryId: assertRepositoryId(repositoryId) });
  }
}

export function assertRepositoryId(repositoryId: string): string {
  if (
    typeof repositoryId !== "string" ||
    !repositoryId.trim() ||
    repositoryId !== repositoryId.trim() ||
    repositoryId.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(repositoryId)
  ) {
    throw new TypeError("Invalid repository ID");
  }
  return repositoryId;
}

function uniqueRepositoryIds(repositoryIds: string[]): string[] {
  return [...new Set(repositoryIds.map(assertRepositoryId))];
}

function uniqueCommitHashes(commitHashes: string[]): string[] {
  return [...new Set(commitHashes.filter((hash) => typeof hash === "string" && hash.length > 0))];
}
