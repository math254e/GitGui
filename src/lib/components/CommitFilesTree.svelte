<script lang="ts">
  import { FileTree, type GitStatus, type GitStatusEntry } from "@pierre/trees";
  import { onMount } from "svelte";
  import type { CommitFile } from "$lib/types/repository";

  type Props = {
    files: CommitFile[];
    selectedFile: CommitFile | null;
    onSelectFile: (file: CommitFile) => void;
  };

  let { files, selectedFile, onSelectFile }: Props = $props();
  let host = $state<HTMLDivElement | null>(null);
  let tree = $state<FileTree | null>(null);
  let lastTreeSignature = $state("");
  let syncingSelection = false;
  let fileByPath = new Map<string, CommitFile>();

  const treePaths = $derived(files.map((file) => file.path).filter(Boolean));
  const treeStatus = $derived(files.map(toGitStatusEntry));

  onMount(() => {
    if (!host) {
      return;
    }

    tree = new FileTree({
      id: "gitgui-commit-files",
      paths: treePaths,
      initialExpansion: "open",
      initialSelectedPaths: selectedFile ? [selectedFile.path] : [],
      density: "compact",
      itemHeight: 28,
      icons: {
        set: "complete",
        colored: true,
      },
      gitStatus: treeStatus,
      unsafeCSS: `
        [data-type="item"][data-item-focused="true"]::before,
        [data-type="item"]:focus-visible::before {
          outline: none;
        }
      `,
      onSelectionChange: handleSelectionChange,
    });
    tree.render({ fileTreeContainer: host });

    return () => {
      tree?.cleanUp();
      tree = null;
    };
  });

  $effect(() => {
    const currentTree = tree;
    const nextFiles = files;

    fileByPath = new Map(nextFiles.map((file) => [file.path, file]));

    const signature = nextFiles
      .map((file) => `${file.path}\0${file.originalPath ?? ""}\0${file.status}`)
      .join("\0");

    if (!currentTree || signature === lastTreeSignature) {
      return;
    }

    const expandedPaths = getExpandedPaths(currentTree);
    currentTree.resetPaths(treePaths, {
      initialExpandedPaths: expandedPaths,
    });
    currentTree.setGitStatus(treeStatus);
    syncSelection(currentTree, selectedFile?.path ?? null);
    lastTreeSignature = signature;
  });

  $effect(() => {
    const currentTree = tree;
    const selectedPath = selectedFile?.path ?? null;

    if (!currentTree) {
      return;
    }

    syncSelection(currentTree, selectedPath);
  });

  function handleSelectionChange(selectedPaths: readonly string[]) {
    if (syncingSelection) {
      return;
    }

    const selectedPath = selectedPaths[selectedPaths.length - 1];
    const file = selectedPath ? fileByPath.get(selectedPath) : undefined;
    if (file) {
      onSelectFile(file);
    }
  }

  function syncSelection(currentTree: FileTree, selectedPath: string | null) {
    const selectedPaths = selectedPath ? [selectedPath] : [];
    const currentSelectedPaths = currentTree.getSelectedPaths();

    if (
      currentSelectedPaths.length === selectedPaths.length &&
      currentSelectedPaths.every((path) => selectedPaths.includes(path))
    ) {
      return;
    }

    syncingSelection = true;
    try {
      for (const currentSelectedPath of currentSelectedPaths) {
        currentTree.getItem(currentSelectedPath)?.deselect();
      }

      for (const nextSelectedPath of selectedPaths) {
        currentTree.getItem(nextSelectedPath)?.select();
      }
    } finally {
      queueMicrotask(() => {
        syncingSelection = false;
      });
    }
  }

  function getExpandedPaths(currentTree: FileTree) {
    const visibleCount = currentTree.getVisibleCount();
    if (!visibleCount) {
      return [];
    }

    return currentTree
      .getVisibleRows(0, visibleCount - 1)
      .filter((row) => row.kind === "directory" && row.isExpanded)
      .map((row) => row.path);
  }

  function toGitStatusEntry(file: CommitFile): GitStatusEntry {
    return {
      path: file.path,
      status: gitStatusFor(file.status),
    };
  }

  function gitStatusFor(status: string): GitStatus {
    switch (status.charAt(0).toUpperCase()) {
      case "A":
        return "added";
      case "D":
        return "deleted";
      case "I":
        return "ignored";
      case "R":
        return "renamed";
      case "?":
        return "untracked";
      default:
        return "modified";
    }
  }
</script>

<div
  bind:this={host}
  class="h-full min-h-0 w-full overflow-hidden"
  role="group"
  aria-label="Changed files"
  style="--trees-bg-override: var(--app-theme-sidebar); --trees-fg-override: var(--app-theme-sidebar-foreground); --trees-fg-muted-override: var(--app-theme-sidebar-muted-foreground); --trees-border-color-override: var(--app-theme-sidebar-border); --trees-bg-muted-override: color-mix(in srgb, var(--app-theme-accent) 7%, var(--app-theme-sidebar)); --trees-selected-bg-override: color-mix(in srgb, var(--app-theme-accent) 14%, var(--app-theme-sidebar)); --trees-selected-fg-override: var(--app-theme-sidebar-foreground); --trees-accent-override: var(--app-theme-accent); --trees-focus-ring-color-override: var(--app-theme-focus); --trees-status-added-override: #2f9e6f; --trees-status-deleted-override: #e5484d; --trees-status-modified-override: #d09a2e; --trees-status-renamed-override: #8b5cf6; --trees-status-untracked-override: #2f9e6f; --trees-status-ignored-override: var(--app-theme-text-subtle); --trees-border-radius-override: 0px; --trees-font-family-override: inherit; --trees-font-size-override: 13px; --trees-padding-inline-override: 0px; --trees-item-padding-x-override: 3px; --trees-item-row-gap-override: 6px; --trees-level-gap-override: 7px; --trees-item-height: 28px;"
></div>
