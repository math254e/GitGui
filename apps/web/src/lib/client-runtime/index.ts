export * from "@gitgui/client-runtime";
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
