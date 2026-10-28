import type { CommitRef } from "./repository";

/** refname:short can include a disambiguating prefix when a branch shares a name. */
export function tagName(ref: CommitRef): string {
  return ref.name.startsWith("refs/tags/") ? ref.name.slice(10) : ref.shortName;
}

/** Immediate feedback; Rust still validates the literal ref with installed Git. */
export function tagNameError(name: string): string | null {
  if (!name) return "Enter a tag name to continue.";
  if (
    name.startsWith("-") || new TextEncoder().encode(name).length > 1024 ||
    /[\x00-\x20\x7f~^:?*\[\\]/.test(name) || name.includes("..") || name.includes("@{") ||
    name.endsWith(".") || name.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  ) return "Enter a valid Git tag name.";
  return null;
}
