import type { GitGuiClient } from "@gitgui/client-runtime";
import type { CommitFile } from "@gitgui/contracts";

type Entry = { files: CommitFile[]; bytes: number };

/** Small presentation cache: mutable stash positions are deliberately not keys. */
export class StashFilesCache {
  private entries = new Map<string, Entry>();
  private bytes = 0;

  constructor(private maxEntries = 32, private maxBytes = 2 * 1024 * 1024) {}

  get(repositoryId: string, oid: string): CommitFile[] | undefined {
    const key = JSON.stringify([repositoryId, oid]);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.files;
  }

  put(repositoryId: string, oid: string, files: CommitFile[]): CommitFile[] {
    const previous = this.get(repositoryId, oid);
    if (previous && equalFiles(previous, files)) return previous;
    this.delete(repositoryId, oid);
    // Count UTF-16 storage plus conservative per-record/key overhead. Huge
    // lists can still render, but must not accumulate across visited stashes.
    const bytes = 128 + 2 * (repositoryId.length + oid.length) + files.reduce(
      (sum, file) => sum + 96 + 2 * (file.path.length + (file.originalPath?.length ?? 0) + file.status.length), 0,
    );
    const copy = files.map((file) => ({ ...file }));
    if (this.maxEntries <= 0 || bytes > this.maxBytes) return copy;
    const key = JSON.stringify([repositoryId, oid]);
    this.entries.set(key, { files: copy, bytes });
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value!;
      const entry = this.entries.get(oldest)!;
      this.entries.delete(oldest);
      this.bytes -= entry.bytes;
    }
    return copy;
  }

  delete(repositoryId: string, oid: string) {
    const key = JSON.stringify([repositoryId, oid]);
    const entry = this.entries.get(key);
    if (entry) { this.entries.delete(key); this.bytes -= entry.bytes; }
  }
}

function equalFiles(left: CommitFile[], right: CommitFile[]) {
  return left.length === right.length && left.every((file, index) => {
    const other = right[index];
    return file.path === other.path && file.originalPath === other.originalPath && file.status === other.status;
  });
}

// A replacement client cannot inherit another session/environment's view data;
// this also allows the cache to disappear when that client is released.
const clients = new WeakMap<GitGuiClient, StashFilesCache>();
export function stashFilesCache(client: GitGuiClient): StashFilesCache {
  let cache = clients.get(client);
  if (!cache) { cache = new StashFilesCache(); clients.set(client, cache); }
  return cache;
}
