import type { GitTagFetchConflict } from "@gitgui/contracts";

export type TagFetchReview = {
  repositoryId: string;
  environmentId: string;
  remote: string;
  conflicts: GitTagFetchConflict[];
  selectedNames: Set<string>;
  error: string;
};

export function parseTagConflicts(value: unknown): GitTagFetchConflict[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16_384) return null;
  const names = new Set<string>();
  const oid = (value: unknown): value is string => typeof value === "string" && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value) && /[1-9a-f]/i.test(value);
  for (const item of value) {
    if (!item || typeof item !== "object" || typeof item.name !== "string" || !item.name || item.name.length > 1024 || /[\x00-\x20\x7f]/.test(item.name) || names.has(item.name) || !oid(item.localObjectId) || !oid(item.remoteObjectId)) return null;
    names.add(item.name);
  }
  return value;
}
