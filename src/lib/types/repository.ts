export type ChangedFile = {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
};

export type CommitInfo = {
  hash: string;
  parents: string[];
  author: string;
  timestamp: number;
  message: string;
};

export type CommitRefType = "localBranch" | "remoteBranch" | "tag";

export type CommitRef = {
  name: string;
  shortName: string;
  target: string;
  refType: CommitRefType;
};

export type CommitFile = {
  path: string;
  originalPath?: string;
  status: string;
};

export type CommitFileDiff = {
  originalPath?: string;
  modifiedPath: string;
  originalContent: string;
  modifiedContent: string;
  isBinary: boolean;
  message?: string;
};

export type GraphEdgeType = "normal" | "merge";

export type GraphCommit = {
  hash: string;
  row: number;
  lane: number;
};

export type GraphEdge = {
  from: string;
  to: string;
  edgeType: GraphEdgeType;
};

export type CommitGraph = {
  commits: GraphCommit[];
  edges: GraphEdge[];
  width: number;
  headLane?: number;
};

export type RepositorySnapshot = {
  info: {
    path: string;
    root: string;
  };
  status: {
    currentBranch?: string;
    headOid?: string;
    ahead: number;
    behind: number;
    changedFiles: ChangedFile[];
  };
  commits: CommitInfo[];
  graph: CommitGraph;
  refs: CommitRef[];
};
