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
};
