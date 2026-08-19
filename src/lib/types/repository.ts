/**
 * Repository and Git DTOs are owned by the generated wire protocol.
 *
 * Keep this module as the compatibility import used by Svelte components while
 * making the generated protocol the single source of truth. In particular,
 * nullable protocol fields remain nullable here; consumers should use
 * nullish checks rather than relying on the old optional-field shapes.
 */
export type {
  ChangedFile,
  CommitFile,
  CommitFileDiff,
  CommitGraph,
  CommitInfo,
  CommitRef,
  CommitRefType,
  GraphCommit,
  GraphEdge,
  GraphEdgeType,
  RepositorySnapshot,
  RepositoryStatus,
  StashInfo,
} from "$lib/generated/protocol";
