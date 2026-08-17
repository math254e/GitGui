export { assertRepositoryId, GitGuiClient } from "./client";
export { GitGuiClientError, connectionError, isUnauthorizedError, protocolErrorToClientError } from "./errors";
export { OrderedEventBus, type SequenceGap, type SequenceGapListener } from "./events";
export {
  EnvironmentRegistry,
  InMemoryEnvironmentMetadataAdapter,
  LocalStorageEnvironmentMetadataAdapter,
  stableEnvironmentId,
  type EnvironmentInput,
  type EnvironmentKind,
  type EnvironmentMetadataAdapter,
  type EnvironmentRecord,
  type EnvironmentRegistryListener,
  type EnvironmentRegistryState,
  type EnvironmentUpdate,
} from "./environment";
export {
  ClientWorkspace,
  type ClientWorkspaceOptions,
  type ClientWorkspaceState,
  type WorkspaceRepositoryError,
  type WorkspaceRepositoryState,
} from "./workspace";
export {
  createEmptyWorkspaceMetadata,
  InMemoryWorkspaceMetadataAdapter,
  LocalStorageWorkspaceMetadataAdapter,
  workspaceMetadataKey,
  WORKSPACE_METADATA_SCHEMA_VERSION,
  type WorkspaceMetadata,
  type WorkspaceMetadataAdapter,
  type WorkspaceMetadataIdentity,
  type WorkspaceRecentMetadata,
} from "./metadata";
export {
  calculateBackoffDelay,
  ReconnectCancelledError,
  ReconnectSupervisor,
  type ReconnectSupervisorOptions,
  type ReconnectTask,
} from "./supervisor";
export {
  resolveEndpoint,
  toHttpUrl,
  toWebSocketUrl,
  SESSION_TOKEN_QUERY_KEY,
  type EndpointUrls,
} from "./urls";
export type {
  ConnectionState,
  ConnectionStateChange,
  GitGuiClientOptions,
  OrderedEventListener,
  StateListener,
  Unsubscribe,
  WebSocketFactory,
  WebSocketLike,
} from "./types";
