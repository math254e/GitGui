<script lang="ts">
  import { FileTree } from "@pierre/trees";
  import { onMount } from "svelte";
  import type { CommitRef, CommitRefType } from "$lib/types/repository";

  type Props = {
    refs: CommitRef[];
    refType: Extract<CommitRefType, "localBranch" | "remoteBranch">;
    currentBranch?: string | null;
    treeId: string;
    selectedRefKey?: string | null;
    selectionRevision?: number;
    onSelectRef?: (ref: CommitRef) => void;
  };

  let {
    refs,
    refType,
    currentBranch = null,
    treeId,
    selectedRefKey = null,
    selectionRevision = 0,
    onSelectRef,
  }: Props = $props();

  let host = $state<HTMLDivElement | null>(null);
  let tree = $state<FileTree | null>(null);
  let treeHeight = $state(26);
  let lastTreeSignature = $state("");
  let branchByPath = new Map<string, CommitRef>();

  const branchSpriteSheet = `
    <svg aria-hidden="true" width="0" height="0">
      <symbol id="gitgui-branch-icon" viewBox="0 0 24 24" fill="none">
        <g transform="translate(1.2 1.2) scale(1.35)">
          <path
            d="M14 5.5C14 4.121 12.879 3 11.5 3C10.121 3 9 4.121 9 5.5C9 6.682 9.826 7.669 10.93 7.928C10.744 8.546 10.177 9 9.5 9H6.5C5.935 9 5.419 9.195 5 9.512V4.949C6.14 4.717 7 3.707 7 2.5C7 1.121 5.879 0 4.5 0C3.121 0 2 1.121 2 2.5C2 3.708 2.86 4.717 4 4.949V11.05C2.86 11.282 2 12.292 2 13.499C2 14.878 3.121 15.999 4.5 15.999C5.879 15.999 7 14.878 7 13.499C7 12.317 6.174 11.33 5.07 11.071C5.256 10.453 5.823 9.999 6.5 9.999H9.5C10.723 9.999 11.74 9.115 11.954 7.953C13.116 7.738 14 6.723 14 5.5ZM3 2.5C3 1.673 3.673 1 4.5 1C5.327 1 6 1.673 6 2.5C6 3.327 5.327 4 4.5 4C3.673 4 3 3.327 3 2.5ZM6 13.5C6 14.327 5.327 15 4.5 15C3.673 15 3 14.327 3 13.5C3 12.673 3.673 12 4.5 12C5.327 12 6 12.673 6 13.5ZM11.5 7C10.673 7 10 6.327 10 5.5C10 4.673 10.673 4 11.5 4C12.327 4 13 4.673 13 5.5C13 6.327 12.327 7 11.5 7Z"
            fill="currentColor"
            fill-rule="evenodd"
          />
        </g>
      </symbol>
    </svg>
  `;

  const branchRefs = $derived(normalizeRefs(refs, refType));
  const branchPaths = $derived(branchRefs.map((ref) => ref.shortName));

  onMount(() => {
    if (!host) {
      return;
    }

    tree = new FileTree({
      id: treeId,
      paths: branchPaths,
      initialExpansion: "open",
      density: "compact",
      itemHeight: 26,
      icons: {
        set: "minimal",
        colored: false,
        spriteSheet: branchSpriteSheet,
        remap: {
          "file-tree-icon-file": "gitgui-branch-icon",
        },
      },
      onSelectionChange: handleSelectionChange,
      renderRowDecoration: renderRowDecoration,
    });
    tree.render({ fileTreeContainer: host });
    syncTreeHeight(tree);
    const unsubscribe = tree.subscribe(() => syncTreeHeight(tree!));

    return () => {
      unsubscribe();
      tree?.cleanUp();
      tree = null;
    };
  });

  $effect(() => {
    const currentTree = tree;
    const nextBranchMap = new Map(branchRefs.map((ref) => [ref.shortName, ref]));
    branchByPath = nextBranchMap;

    const signature = [currentBranch ?? "", ...branchRefs.map((ref) => `${ref.shortName}\0${ref.target}`)].join("\0");
    if (!currentTree || signature === lastTreeSignature) {
      return;
    }

    const expandedPaths = getExpandedPaths(currentTree);
    currentTree.resetPaths(branchPaths, {
      initialExpandedPaths: expandedPaths,
    });
    syncTreeHeight(currentTree);
    syncSelection(currentTree, selectedRefKey);

    lastTreeSignature = signature;
  });

  $effect(() => {
    const currentTree = tree;
    const selectionKey = selectedRefKey;
    selectionRevision;

    if (!currentTree) {
      return;
    }

    syncSelection(currentTree, selectionKey);
  });

  function syncTreeHeight(currentTree: FileTree) {
    treeHeight = Math.max(1, currentTree.getVisibleCount()) * currentTree.getItemHeight();
  }

  function handleSelectionChange(selectedPaths: readonly string[]) {
    const selectedPath = selectedPaths[selectedPaths.length - 1];
    if (!selectedPath) {
      return;
    }

    const ref = branchByPath.get(selectedPath) ?? branchByPath.get(selectedPath.replace(/\/$/, ""));
    if (ref) {
      onSelectRef?.(ref);
    }
  }

  function syncSelection(currentTree: FileTree, selectionKey: string | null) {
    const selectedRef = branchRefs.find((ref) => refSelectionKey(ref) === selectionKey);
    const selectedPath = selectedRef?.shortName ?? null;
    const currentSelectedPaths = currentTree.getSelectedPaths();

    if (
      currentSelectedPaths.length === (selectedPath ? 1 : 0) &&
      (!selectedPath || currentSelectedPaths[0] === selectedPath)
    ) {
      return;
    }

    for (const currentSelectedPath of currentSelectedPaths) {
      currentTree.getItem(currentSelectedPath)?.deselect();
    }

    if (selectedPath) {
      currentTree.getItem(selectedPath)?.select();
    }
  }

  function refSelectionKey(ref: CommitRef) {
    return `${ref.refType}:${ref.shortName}`;
  }

  function renderRowDecoration({ item }: { item: { path: string } }) {
    if (refType !== "localBranch") {
      return null;
    }

    const ref = branchByPath.get(item.path);
    if (!ref || ref.shortName !== currentBranch) {
      return null;
    }

    return {
      text: "HEAD",
      title: "Current branch",
      color: "var(--trees-accent)",
    };
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

  function normalizeRefs(currentRefs: CommitRef[], type: Props["refType"]) {
    const unique = new Map<string, CommitRef>();

    for (const ref of currentRefs) {
      if (ref.refType === type && ref.shortName) {
        unique.set(ref.shortName, ref);
      }
    }

    return [...unique.values()].sort((first, second) => first.shortName.localeCompare(second.shortName));
  }
</script>

<div
  bind:this={host}
  class="min-h-0 w-full overflow-hidden"
  aria-label={`${refType === "localBranch" ? "Local" : "Remote"} branches`}
  style={`height: ${treeHeight}px; --trees-bg-override: var(--app-theme-sidebar); --trees-fg-override: var(--app-theme-sidebar-foreground); --trees-fg-muted-override: var(--app-theme-sidebar-muted-foreground); --trees-border-color-override: var(--app-theme-sidebar-border); --trees-selected-bg-override: var(--app-theme-sidebar-row-active); --trees-selected-fg-override: var(--app-theme-accent-surface-foreground); --trees-accent-override: var(--app-theme-accent); --trees-focus-ring-color-override: var(--app-theme-focus); --trees-font-family-override: inherit; --trees-font-size-override: 13px; --trees-padding-inline-override: 0px; --trees-item-padding-x-override: 3px; --trees-item-row-gap-override: 3px; --trees-level-gap-override: 6px; --trees-item-height: 26px;`}
></div>
