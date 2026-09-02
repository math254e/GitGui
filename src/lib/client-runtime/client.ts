import type {
  OrderedEventEnvelope,
  CommitFileDiffParams,
  CommitFilesParams,
  CommitFilesResult,
  FileDiffResult,
  GitBranchCreateParams,
  GitBranchCreateResult,
  GitBranchListResult,
  GitBranchSwitchParams,
  GitBranchSwitchResult,
  GitCommitParams,
  GitCommitResult,
  GitFetchResult,
  GitPathsParams,
  GitPullResult,
  GitPushResult,
  GitStageResult,
  GitStashPopResult,
  GitStashPushParams,
  GitStashPushResult,
  GitStatusParams,
  GitStatusResult,
  GitUnstageResult,
  PrefetchCommitDiffsParams,
  PrefetchCommitDiffsResult,
  PrefetchCommitFilesParams,
  PrefetchCommitFilesResult,
  RepositoriesListResult,
  RepositoriesCreateParams,
  RepositoriesCreateResult,
  RepositoriesOpenParams,
  RepositoriesOpenResult,
  RepositoriesRefreshParams,
  RepositoriesRefreshResult,
  RepositoriesRemoveParams,
  RepositoriesRemoveResult,
  RepositoryGraphParams,
  RepositoryGraphResult,
  RepositorySnapshotParams,
  RepositorySnapshotResult,
  RepositorySummary,
  ResponseEnvelope,
  ServerInfo,
  ServerReadiness,
  ServerStatus,
  WelcomeMessage,
  WorkingTreeFileDiffParams,
} from "$lib/generated/protocol";
import { connectionError, GitGuiClientError, isUnauthorizedError, protocolErrorToClientError } from "./errors";
import { OrderedEventBus, type SequenceGap, type SequenceGapListener } from "./events";
import { resolveEndpoint, toHttpUrl, toWebSocketUrl } from "./urls";
import type {
  GitGuiClientOptions,
  StateListener,
  Unsubscribe,
  WebSocketFactory,
  WebSocketLike,
} from "./types";

const DEFAULT_PROTOCOL_VERSION = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  timeout?: ReturnType<typeof setTimeout>;
}

interface ConnectionAttempt {
  generation: number;
  promise: Promise<WelcomeMessage>;
  resolve: (welcome: WelcomeMessage) => void;
  reject: (error: unknown) => void;
  settled: boolean;
}

/** Browser-safe client for one GitGui HTTP/WebSocket host. */
export class GitGuiClient {
  private readonly endpointUrls;
  private readonly webSocketFactory: WebSocketFactory;
  private readonly sessionToken?: string;
  private readonly expectedProtocolVersion: number;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<string, PendingRequest<unknown>>();
  private readonly stateListeners = new Set<StateListener>();
  private readonly eventBus = new OrderedEventBus();
  private socket?: WebSocketLike;
  private connectionGeneration = 0;
  private activeAttempt?: ConnectionAttempt;
  private welcome?: WelcomeMessage;
  private requestCounter = 0;
  private _state: import("./types").ConnectionState = "idle";

  constructor(options: GitGuiClientOptions) {
    this.endpointUrls = resolveEndpoint(options.endpoint);
    this.sessionToken = options.sessionToken;
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.expectedProtocolVersion = options.expectedProtocolVersion ?? DEFAULT_PROTOCOL_VERSION;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isInteger(this.expectedProtocolVersion) || this.expectedProtocolVersion < 0) {
      throw new RangeError("expectedProtocolVersion must be a non-negative integer");
    }
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new RangeError("requestTimeoutMs must be a finite positive number");
    }
    if (options.sessionToken !== undefined && (!options.sessionToken || /[\u0000-\u001f\u007f]/.test(options.sessionToken))) {
      throw new TypeError("sessionToken must be a non-empty string without control characters");
    }
  }

  get state(): import("./types").ConnectionState {
    return this._state;
  }

  get endpoint(): typeof this.endpointUrls {
    return { ...this.endpointUrls };
  }

  get serverWelcome(): WelcomeMessage | undefined {
    return this.welcome;
  }

  get lastEventSequence(): number | undefined {
    return this.eventBus.sequence;
  }

  connect(options: { reconnecting?: boolean } = {}): Promise<WelcomeMessage> {
    if (this._state === "ready" && this.welcome) return Promise.resolve(this.welcome);
    if (this.activeAttempt && !this.activeAttempt.settled) return this.activeAttempt.promise;

    const generation = ++this.connectionGeneration;
    let resolveAttempt!: (welcome: WelcomeMessage) => void;
    let rejectAttempt!: (error: unknown) => void;
    const promise = new Promise<WelcomeMessage>((resolve, reject) => {
      resolveAttempt = resolve;
      rejectAttempt = reject;
    });
    const attempt: ConnectionAttempt = {
      generation,
      promise,
      resolve: resolveAttempt,
      reject: rejectAttempt,
      settled: false,
    };
    this.activeAttempt = attempt;
    this.setState(options.reconnecting ? "reconnecting" : "connecting");

    try {
      const socket = this.webSocketFactory(toWebSocketUrl(this.endpointUrls, "/ws", this.sessionToken));
      if (this.activeAttempt !== attempt) {
        try {
          socket.close(1000, "GitGui connection was cancelled");
        } catch {
          // A custom WebSocket implementation must not mask cancellation.
        }
        return promise;
      }
      this.socket = socket;
      socket.onopen = () => undefined;
      socket.onmessage = (event) => this.handleMessage(attempt, socket, event.data);
      socket.onerror = () => undefined;
      socket.onclose = (event) => this.handleClose(attempt, socket, event);
    } catch (error) {
      this.failConnection(attempt, connectionError("Unable to create the GitGui WebSocket", error), "failed");
    }
    return promise;
  }

  disconnect(reason = "Client disconnected"): void {
    const error = new GitGuiClientError(reason, { code: "disconnected" });
    const attempt = this.activeAttempt;
    const socket = this.socket;
    this.activeAttempt = undefined;
    this.socket = undefined;
    this.rejectAttempt(attempt, error);
    this.rejectPending(error);
    try {
      socket?.close(1000, reason);
    } catch {
      // A custom WebSocket implementation must not prevent deterministic cleanup.
    }
    this.setState("disconnected", error);
  }

  onStateChange(listener: StateListener): Unsubscribe {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onEvent(listener: (event: OrderedEventEnvelope) => void): Unsubscribe {
    return this.eventBus.onEvent(listener);
  }

  on(eventName: string, listener: (event: OrderedEventEnvelope) => void): Unsubscribe {
    return this.eventBus.on(eventName, listener);
  }

  onSequenceGap(listener: SequenceGapListener): Unsubscribe {
    return this.eventBus.onSequenceGap(listener);
  }

  async getReadiness(): Promise<ServerReadiness> {
    const response = await fetch(toHttpUrl(this.endpointUrls, "/ready"));
    if (!response.ok) throw connectionError(`GitGui readiness request failed with HTTP ${response.status}`);
    return (await response.json()) as ServerReadiness;
  }

  getServerInfo(): Promise<ServerInfo> {
    return this.request<ServerInfo>("server.get_info", {});
  }

  getServerStatus(): Promise<ServerStatus> {
    return this.request<ServerStatus>("server.get_status", {});
  }

  async listRepositories(): Promise<RepositorySummary[]> {
    const result = await this.request<RepositoriesListResult>("repositories.list", {});
    return result.repositories;
  }

  openRepository(path: string): Promise<RepositoriesOpenResult> {
    if (!path.trim()) throw new TypeError("Repository path cannot be empty");
    const params: RepositoriesOpenParams = { path };
    return this.request<RepositoriesOpenResult>("repositories.open", params);
  }

  createRepository(
    parentPath: string,
    name: string,
    options: { initialBranch?: string; initializeLfs?: boolean } = {},
  ): Promise<RepositoriesCreateResult> {
    if (!parentPath.trim()) throw new TypeError("Repository parent path cannot be empty");
    if (!name.trim()) throw new TypeError("Repository name cannot be empty");
    const params: RepositoriesCreateParams = {
      parentPath,
      name,
      ...(options.initialBranch?.trim() ? { initialBranch: options.initialBranch.trim() } : {}),
      initializeLfs: options.initializeLfs ?? false,
    };
    return this.request<RepositoriesCreateResult>("repositories.create", params);
  }

  removeRepository(repositoryId: string): Promise<RepositoriesRemoveResult> {
    const params: RepositoriesRemoveParams = { repositoryId: assertRepositoryId(repositoryId) };
    return this.request<RepositoriesRemoveResult>("repositories.remove", params);
  }

  getRepositorySnapshot(repositoryId: string): Promise<RepositorySnapshotResult> {
    const params: RepositorySnapshotParams = { repositoryId: assertRepositoryId(repositoryId) };
    return this.request<RepositorySnapshotResult>("repositories.get_snapshot", params);
  }

  getRepositoryGraph(params: RepositoryGraphParams): Promise<RepositoryGraphResult> {
    return this.request<RepositoryGraphResult>("repositories.get_graph", {
      ...params,
      repositoryId: assertRepositoryId(params.repositoryId),
      targetCommits: uniqueCommitHashes(params.targetCommits),
    } satisfies RepositoryGraphParams);
  }

  refreshRepositories(repositoryIds: string[]): Promise<RepositoriesRefreshResult> {
    const params: RepositoriesRefreshParams = {
      repositoryIds: uniqueRepositoryIds(repositoryIds),
    };
    return this.request<RepositoriesRefreshResult>("repositories.refresh", params);
  }

  getCommitFiles(repositoryId: string, commitHash: string): Promise<CommitFilesResult> {
    const params: CommitFilesParams = {
      repositoryId: assertRepositoryId(repositoryId),
      commitHash,
    };
    return this.request<CommitFilesResult>("git.commit_files", params);
  }

  getCommitFileDiff(params: CommitFileDiffParams): Promise<FileDiffResult> {
    return this.request<FileDiffResult>("git.commit_file_diff", {
      ...params,
      repositoryId: assertRepositoryId(params.repositoryId),
    } satisfies CommitFileDiffParams);
  }

  getWorkingTreeFileDiff(params: WorkingTreeFileDiffParams): Promise<FileDiffResult> {
    return this.request<FileDiffResult>("git.working_tree_file_diff", {
      ...params,
      repositoryId: assertRepositoryId(params.repositoryId),
    } satisfies WorkingTreeFileDiffParams);
  }

  prefetchCommitFiles(repositoryId: string, commitHashes: string[]): Promise<PrefetchCommitFilesResult> {
    const params: PrefetchCommitFilesParams = {
      repositoryId: assertRepositoryId(repositoryId),
      commitHashes: [...commitHashes],
    };
    return this.request<PrefetchCommitFilesResult>("git.prefetch_commit_files", params);
  }

  prefetchCommitDiffs(params: PrefetchCommitDiffsParams): Promise<PrefetchCommitDiffsResult> {
    return this.request<PrefetchCommitDiffsResult>("git.prefetch_commit_diffs", {
      ...params,
      repositoryId: assertRepositoryId(params.repositoryId),
    } satisfies PrefetchCommitDiffsParams);
  }

  getGitStatus(repositoryId: string): Promise<GitStatusResult> {
    const params: GitStatusParams = { repositoryId: assertRepositoryId(repositoryId) };
    return this.request<GitStatusResult>("git.status", params);
  }

  stage(repositoryId: string, paths: string[] = []): Promise<GitStageResult> {
    const params: GitPathsParams = { repositoryId: assertRepositoryId(repositoryId), paths: [...paths] };
    return this.request<GitStageResult>("git.stage", params);
  }

  unstage(repositoryId: string, paths: string[] = []): Promise<GitUnstageResult> {
    const params: GitPathsParams = { repositoryId: assertRepositoryId(repositoryId), paths: [...paths] };
    return this.request<GitUnstageResult>("git.unstage", params);
  }

  commit(params: GitCommitParams): Promise<GitCommitResult> {
    return this.request<GitCommitResult>("git.commit", {
      ...params,
      repositoryId: assertRepositoryId(params.repositoryId),
    } satisfies GitCommitParams);
  }

  fetch(repositoryId: string): Promise<GitFetchResult> {
    return this.request<GitFetchResult>("git.fetch", { repositoryId: assertRepositoryId(repositoryId) });
  }

  pull(repositoryId: string): Promise<GitPullResult> {
    return this.request<GitPullResult>("git.pull", { repositoryId: assertRepositoryId(repositoryId) });
  }

  push(repositoryId: string): Promise<GitPushResult> {
    return this.request<GitPushResult>("git.push", { repositoryId: assertRepositoryId(repositoryId) });
  }

  listBranches(repositoryId: string): Promise<GitBranchListResult> {
    return this.request<GitBranchListResult>("git.branch.list", { repositoryId: assertRepositoryId(repositoryId) });
  }

  createBranch(params: GitBranchCreateParams): Promise<GitBranchCreateResult> {
    return this.request<GitBranchCreateResult>("git.branch.create", {
      ...params,
      repositoryId: assertRepositoryId(params.repositoryId),
    } satisfies GitBranchCreateParams);
  }

  switchBranch(params: GitBranchSwitchParams): Promise<GitBranchSwitchResult> {
    return this.request<GitBranchSwitchResult>("git.branch.switch", {
      ...params,
      repositoryId: assertRepositoryId(params.repositoryId),
    } satisfies GitBranchSwitchParams);
  }

  stashPush(params: GitStashPushParams): Promise<GitStashPushResult> {
    return this.request<GitStashPushResult>("git.stash.push", {
      ...params,
      repositoryId: assertRepositoryId(params.repositoryId),
    } satisfies GitStashPushParams);
  }

  stashPop(repositoryId: string): Promise<GitStashPopResult> {
    return this.request<GitStashPopResult>("git.stash.pop", { repositoryId: assertRepositoryId(repositoryId) });
  }

  request<T>(method: string, params: unknown = {}): Promise<T> {
    const socket = this.socket;
    if (this._state !== "ready" || !socket || !this.isActiveSocket(socket)) {
      return Promise.reject(new GitGuiClientError("GitGui client is not connected", { code: "not_connected" }));
    }

    const id = this.nextRequestId();
    const envelope = { id, method, params };
    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest<T> = { resolve, reject };
      pending.timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new GitGuiClientError(`GitGui request timed out: ${method}`, { code: "request_timeout", requestId: id }));
      }, this.requestTimeoutMs);
      this.pending.set(id, pending as PendingRequest<unknown>);
      try {
        if (!this.isActiveSocket(socket)) throw new Error("GitGui WebSocket is no longer active");
        socket.send(JSON.stringify(envelope));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(pending.timeout);
        reject(connectionError("Unable to send GitGui request", error));
      }
    });
  }

  private handleMessage(attempt: ConnectionAttempt, socket: WebSocketLike, data: unknown): void {
    if (!this.isActiveSocket(socket) || this.activeAttempt !== attempt) return;
    if (typeof data !== "string") {
      this.failConnection(attempt, connectionError("GitGui sent a non-text WebSocket frame"), "failed");
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch (error) {
      this.failConnection(attempt, connectionError("GitGui sent invalid JSON", error), "failed");
      return;
    }

    if (isWelcomeMessage(message)) {
      this.handleWelcome(attempt, socket, message);
    } else if (isResponseEnvelope(message)) {
      this.handleResponse(message);
    } else if (isOrderedEvent(message)) {
      this.eventBus.accept(message);
    } else if (isProtocolErrorMessage(message)) {
      const error = protocolErrorToClientError(message.error);
      this.failConnection(attempt, error, isUnauthorizedError(error) ? "unauthorized" : "failed");
    } else {
      this.failConnection(attempt, connectionError("GitGui sent an unknown protocol message"), "failed");
    }
  }

  private handleWelcome(attempt: ConnectionAttempt, socket: WebSocketLike, welcome: WelcomeMessage): void {
    if (!this.isActiveSocket(socket) || this.activeAttempt !== attempt || attempt.settled) return;
    if (welcome.protocol_version !== this.expectedProtocolVersion) {
      this.failConnection(
        attempt,
        new GitGuiClientError(
          `GitGui protocol version ${welcome.protocol_version} is incompatible with ${this.expectedProtocolVersion}`,
          { code: "incompatible_protocol" },
        ),
        "incompatible",
      );
      return;
    }
    this.welcome = welcome;
    this.eventBus.reset();
    this.resolveAttempt(attempt, welcome);
    this.setState("ready");
  }

  private handleResponse(response: ResponseEnvelope): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (pending.timeout) clearTimeout(pending.timeout);
    if (response.ok) {
      pending.resolve(response.result);
      return;
    }

    const error = protocolErrorToClientError(response.error, response.id);
    if (isUnauthorizedError(error)) this.setState("unauthorized", error);
    pending.reject(error);
  }

  private handleClose(attempt: ConnectionAttempt, socket: WebSocketLike, event: { code: number; reason: string }): void {
    if (!this.isActiveSocket(socket) || this.activeAttempt !== attempt) return;
    const error = connectionError(event.reason || `GitGui WebSocket closed (${event.code})`);
    this.activeAttempt = undefined;
    this.socket = undefined;
    this.rejectAttempt(attempt, error);
    this.rejectPending(error);
    if (this._state !== "incompatible" && this._state !== "failed") {
      this.setState(this._state === "ready" ? "disconnected" : "failed", error);
    }
  }

  private failConnection(
    attempt: ConnectionAttempt,
    error: GitGuiClientError,
    state: Extract<import("./types").ConnectionState, "incompatible" | "unauthorized" | "failed">,
  ): void {
    if (this.activeAttempt !== attempt) return;
    const socket = this.socket;
    this.activeAttempt = undefined;
    this.socket = undefined;
    this.rejectAttempt(attempt, error);
    this.rejectPending(error);
    try {
      socket?.close(1002, error.message);
    } catch {
      // A custom WebSocket implementation must not prevent state cleanup.
    }
    this.setState(state, error);
  }

  private resolveAttempt(attempt: ConnectionAttempt, welcome: WelcomeMessage): void {
    if (attempt.settled) return;
    attempt.settled = true;
    attempt.resolve(welcome);
  }

  private rejectAttempt(attempt: ConnectionAttempt | undefined, error: unknown): void {
    if (!attempt || attempt.settled) return;
    attempt.settled = true;
    attempt.reject(error);
  }

  private rejectPending(error: unknown): void {
    for (const [id, pending] of this.pending) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private setState(state: import("./types").ConnectionState, error?: Error): void {
    if (this._state === state && !error) return;
    const previous = this._state;
    this._state = state;
    const change = { previous, current: state, error };
    for (const listener of this.stateListeners) listener(change);
  }

  private nextRequestId(): string {
    this.requestCounter += 1;
    return `request-${this.requestCounter}`;
  }

  private isActiveSocket(socket: WebSocketLike): boolean {
    return this.socket === socket
      && this.activeAttempt !== undefined
      && this.activeAttempt.generation === this.connectionGeneration;
  }
}

function defaultWebSocketFactory(url: string): WebSocketLike {
  if (typeof globalThis.WebSocket !== "function") {
    throw new GitGuiClientError("WebSocket is unavailable in this runtime", { code: "websocket_unavailable" });
  }
  return new globalThis.WebSocket(url) as unknown as WebSocketLike;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isWelcomeMessage(value: unknown): value is WelcomeMessage {
  return isRecord(value)
    && value.type === "welcome"
    && typeof value.server_id === "string"
    && typeof value.protocol_version === "number"
    && Number.isSafeInteger(value.protocol_version)
    && value.protocol_version >= 0
    && Array.isArray(value.capabilities)
    && value.capabilities.every((capability) => typeof capability === "string");
}

function isResponseEnvelope(value: unknown): value is ResponseEnvelope {
  if (!isRecord(value) || value.type !== "response" || typeof value.id !== "string") return false;
  if (value.ok === true) return "result" in value;
  return value.ok === false && isProtocolErrorValue(value.error);
}

function isOrderedEvent(value: unknown): value is OrderedEventEnvelope {
  return isRecord(value)
    && value.type === "event"
    && typeof value.sequence === "number"
    && Number.isSafeInteger(value.sequence)
    && value.sequence >= 0
    && typeof value.event === "string"
    && "payload" in value;
}

function isProtocolErrorMessage(value: unknown): value is { type: "protocol_error"; error: import("$lib/generated/protocol").ProtocolError } {
  return isRecord(value)
    && value.type === "protocol_error"
    && isProtocolErrorValue(value.error);
}

function isProtocolErrorValue(value: unknown): value is import("$lib/generated/protocol").ProtocolError {
  return isRecord(value)
    && typeof value.code === "string"
    && typeof value.message === "string";
}

export function assertRepositoryId(repositoryId: string): string {
  if (typeof repositoryId !== "string" || !repositoryId.trim() || repositoryId !== repositoryId.trim() || repositoryId.length > 512 || /[\u0000-\u001f\u007f]/.test(repositoryId)) {
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
