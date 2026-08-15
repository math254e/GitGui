<script lang="ts" module>
  import type { CommitFile } from "$lib/types/repository";

  export type FileTreeNode = {
    name: string;
    path: string;
    key: string;
    children: FileTreeNode[];
    file: CommitFile | null;
  };
</script>

<script lang="ts">
  import { ChevronRight, File, Folder } from "@lucide/svelte";
  import CommitFilesTreeNode from "$lib/components/CommitFilesTreeNode.svelte";

  type Props = {
    node: FileTreeNode;
    depth: number;
    selectedFile: CommitFile | null;
    collapsedFolders: Set<string>;
    onSelectFile: (file: CommitFile) => void;
  };

  let { node, depth, selectedFile, collapsedFolders = $bindable(), onSelectFile }: Props = $props();

  const isFolder = $derived(!node.file);
  const isCollapsed = $derived(collapsedFolders.has(node.path));
  const isSelected = $derived(Boolean(node.file && selectedFile && sameFile(selectedFile, node.file)));
  const hiddenFileCount = $derived(countFiles(node));

  function toggleFolder(path: string) {
    const next = new Set(collapsedFolders);

    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }

    collapsedFolders = next;
  }

  function statusLabel(file: CommitFile) {
    const indexStatus = file.status.charAt(0);
    const worktreeStatus = file.status.charAt(1);

    return worktreeStatus && worktreeStatus !== "." ? worktreeStatus : indexStatus || "?";
  }

  function statusTitle(file: CommitFile) {
    const status = file.status || "Unknown";
    return file.originalPath ? `${status}: ${file.originalPath} -> ${file.path}` : `${status}: ${file.path}`;
  }

  function selectFile(file: CommitFile | null) {
    if (file) {
      onSelectFile(file);
    }
  }

  function sameFile(first: CommitFile, second: CommitFile) {
    return (
      first.path === second.path &&
      first.originalPath === second.originalPath &&
      first.status === second.status
    );
  }

  function countFiles(treeNode: FileTreeNode): number {
    if (treeNode.file) {
      return 1;
    }

    return treeNode.children.reduce((total, child) => total + countFiles(child), 0);
  }
</script>

{#if isFolder}
  <button
    class="flex h-8 w-full min-w-0 items-center gap-1.5 px-3 text-left text-sm font-medium text-[var(--app-theme-sidebar-foreground)] transition hover:bg-[var(--app-theme-sidebar-row-hover)]"
    style={`padding-left: ${12 + depth * 16}px`}
    type="button"
    onclick={() => toggleFolder(node.path)}
  >
    <ChevronRight
      aria-hidden="true"
      size={14}
      strokeWidth={2.5}
      class={`shrink-0 text-[var(--app-theme-text-subtle)] transition-transform ${isCollapsed ? "rotate-0" : "rotate-90"}`}
    />
    <Folder aria-hidden="true" size={15} class="shrink-0 text-[var(--app-theme-text-muted)]" />
    <span class="truncate">{node.name}</span>
    {#if isCollapsed}
      <span class="shrink-0 text-xs font-semibold text-[var(--app-theme-text-subtle)]">{hiddenFileCount}</span>
    {/if}
  </button>

  {#if !isCollapsed}
    {#each node.children as child (child.key)}
      <CommitFilesTreeNode node={child} depth={depth + 1} {selectedFile} {onSelectFile} bind:collapsedFolders />
    {/each}
  {/if}
{:else if node.file}
  <button
    class={`flex h-8 w-full min-w-0 items-center gap-2 px-3 text-left text-sm transition hover:bg-[var(--app-theme-sidebar-row-hover)] ${
      isSelected
        ? "bg-[var(--app-theme-sidebar-row-selected)] text-[var(--app-theme-accent-surface-foreground)]"
        : "text-[var(--app-theme-sidebar-foreground)]"
    }`}
    style={`padding-left: ${28 + depth * 16}px`}
    title={statusTitle(node.file)}
    type="button"
    onclick={() => selectFile(node.file)}
  >
    <File aria-hidden="true" size={14} class="shrink-0 text-[var(--app-theme-sidebar-muted-foreground)]" />
    <code class="w-4 shrink-0 text-xs font-semibold text-[var(--app-theme-accent)]">{statusLabel(node.file)}</code>
    <span class="truncate">{node.name}</span>
  </button>
{/if}
