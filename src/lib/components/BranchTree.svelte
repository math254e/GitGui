<script lang="ts">
  import { FileTree } from "@pierre/trees";
  import { onMount } from "svelte";
  import type { CommitRef, CommitRefType } from "$lib/types/repository";
  import { graphRefKey, isCurrentBranchRef } from "$lib/types/branch-visibility";

  type Props = {
    refs: CommitRef[];
    refType: Extract<CommitRefType, "localBranch" | "remoteBranch">;
    currentBranch?: string | null;
    treeId: string;
    selectedCommitHash?: string | null;
    visibleRefKeys?: ReadonlySet<string>;
    onSelectRef?: (ref: CommitRef) => void;
    onSwitchBranch?: (branchName: string) => void;
    onToggleRefs?: (refs: CommitRef[], visible: boolean) => void;
  };

  let {
    refs,
    refType,
    currentBranch = null,
    treeId,
    selectedCommitHash = null,
    visibleRefKeys = new Set<string>(),
    onSelectRef,
    onSwitchBranch,
    onToggleRefs,
  }: Props = $props();

  let host = $state<HTMLDivElement | null>(null);
  let tree = $state<FileTree | null>(null);
  let treeHeight = $state(26);
  let lastTreeSignature = $state("");
  let branchByPath = new Map<string, CommitRef>();
  let syncingSelection = false;

  const branchSpriteSheet = `
    <svg aria-hidden="true" width="0" height="0">
      <symbol id="gitgui-branch-icon" viewBox="0 0 24 24" fill="none">
        <g transform="translate(2.8 2.8) scale(1.15)">
          <path
            d="M14 5.5C14 4.121 12.879 3 11.5 3C10.121 3 9 4.121 9 5.5C9 6.682 9.826 7.669 10.93 7.928C10.744 8.546 10.177 9 9.5 9H6.5C5.935 9 5.419 9.195 5 9.512V4.949C6.14 4.717 7 3.707 7 2.5C7 1.121 5.879 0 4.5 0C3.121 0 2 1.121 2 2.5C2 3.708 2.86 4.717 4 4.949V11.05C2.86 11.282 2 12.292 2 13.499C2 14.878 3.121 15.999 4.5 15.999C5.879 15.999 7 14.878 7 13.499C7 12.317 6.174 11.33 5.07 11.071C5.256 10.453 5.823 9.999 6.5 9.999H9.5C10.723 9.999 11.74 9.115 11.954 7.953C13.116 7.738 14 6.723 14 5.5ZM3 2.5C3 1.673 3.673 1 4.5 1C5.327 1 6 1.673 6 2.5C6 3.327 5.327 4 4.5 4C3.673 4 3 3.327 3 2.5ZM6 13.5C6 14.327 5.327 15 4.5 15C3.673 15 3 14.327 3 13.5C3 12.673 3.673 12 4.5 12C5.327 12 6 12.673 6 13.5ZM11.5 7C10.673 7 10 6.327 10 5.5C10 4.673 10.673 4 11.5 4C12.327 4 13 4.673 13 5.5C13 6.327 12.327 7 11.5 7Z"
            fill="currentColor"
            fill-rule="evenodd"
          />
        </g>
      </symbol>
      <symbol id="gitgui-eye" viewBox="0 0 24 24" fill="none">
        <g transform="translate(1.8 1.8) scale(0.85)">
          <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.8" />
        </g>
      </symbol>
      <symbol id="gitgui-eye-off" viewBox="0 0 24 24" fill="none">
        <g transform="translate(1.8 1.8) scale(0.85)">
          <path d="m3 3 18 18M10.584 10.587a2 2 0 0 0 2.829 2.829M9.363 5.365A10.77 10.77 0 0 1 12 5.03c4.5 0 8.36 2.9 9.74 6.94a10.8 10.8 0 0 1-4.015 5.27M6.228 6.228A10.8 10.8 0 0 0 2.26 12c1.38 4.04 5.24 6.94 9.74 6.94a10.7 10.7 0 0 0 2.636-.334" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </g>
      </symbol>
      <symbol id="gitgui-current" viewBox="0 0 24 24" fill="none">
        <rect x="3" y="3" width="18" height="18" rx="3" fill="currentColor" />
        <path d="m7 12 3 3 7-7" stroke="var(--trees-bg)" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" />
      </symbol>
    </svg>
  `;

  const branchRefs = $derived(normalizeRefs(refs, refType));
  const branchPaths = $derived(branchRefs.map((ref) => ref.shortName));
  const selectedBranchPaths = $derived(
    new Set(
      branchRefs
        .filter((ref) => ref.target === selectedCommitHash)
        .map((ref) => ref.shortName),
    ),
  );

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
      unsafeCSS: `
        [data-item-section="decoration"] {
          position: absolute;
          top: 0;
          left: 2px;
          z-index: 4;
          width: 18px;
          height: 100%;
          color: var(--trees-fg-muted);
        }

        [data-type="item"] {
          padding-left: 22px;
          white-space: nowrap;
        }

        [data-type="item"][data-item-focused="true"]::before,
        [data-type="item"]:focus-visible::before {
          outline: none;
        }

        /* Branch names should keep their beginning visible when the sidebar is narrow. */
        [data-item-section="content"] {
          flex: 1 1 auto;
          min-width: 0;
          white-space: nowrap;
        }

        [data-item-section="content"] > [data-truncate-group-container="middle"] {
          display: block;
          min-width: 0;
          max-width: 100%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap !important;
        }

        [data-item-section="content"] > [data-truncate-group-container="middle"] > div,
        [data-item-section="content"] > [data-truncate-group-container="middle"] [data-truncate-container],
        [data-item-section="content"] > [data-truncate-group-container="middle"] [data-truncate-grid],
        [data-item-section="content"] > [data-truncate-group-container="middle"] [data-truncate-grid] > div:not([data-truncate-marker-cell]):not([data-truncate-fill]) {
          display: contents;
        }

        [data-item-section="content"] > [data-truncate-group-container="middle"] [data-truncate-content="visible"] {
          display: inline;
          direction: ltr;
          white-space: nowrap !important;
        }

        [data-item-section="content"] > [data-truncate-group-container="middle"] [data-truncate-content="visible"] > span {
          unicode-bidi: normal;
        }

        [data-item-section="content"] > [data-truncate-group-container="middle"] [data-truncate-content="overflow"],
        [data-item-section="content"] > [data-truncate-group-container="middle"] [data-truncate-marker-cell],
        [data-item-section="content"] > [data-truncate-group-container="middle"] [data-truncate-fill] {
          display: none;
        }

        [data-item-section="decoration"] > span {
          opacity: 0;
          cursor: pointer;
          transition: color .12s, opacity .12s;
          pointer-events: auto;
        }

        [data-type="item"]:hover [data-item-section="decoration"] > span,
        [data-item-section="decoration"] > span:has([data-icon-name="gitgui-eye-off"]),
        [data-item-section="decoration"] > span:has([data-icon-name="gitgui-current"]) {
          opacity: 1;
        }

        [data-type="item"]:has([data-icon-name="gitgui-eye-off"]) [data-item-section="content"] {
          color: var(--trees-fg-muted);
          opacity: 0.68;
        }

        [data-type="item"]:hover [data-item-section="decoration"] {
          color: var(--trees-accent);
        }
      `,
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

    const visibilitySignature = branchRefs
      .map((ref) => `${graphRefKey(ref)}\0${isRefVisible(ref)}`)
      .join("\0");
    const signature = [
      currentBranch ?? "",
      ...branchRefs.map((ref) => `${ref.shortName}\0${ref.target}`),
      visibilitySignature,
    ].join("\0");
    if (!currentTree || signature === lastTreeSignature) {
      return;
    }

    const expandedPaths = getExpandedPaths(currentTree);
    currentTree.resetPaths(branchPaths, {
      initialExpandedPaths: expandedPaths,
    });
    syncTreeHeight(currentTree);
    syncSelection(currentTree, selectedBranchPaths);

    lastTreeSignature = signature;
  });

  $effect(() => {
    const currentTree = tree;
    const selectionPaths = selectedBranchPaths;

    if (!currentTree) {
      return;
    }

    syncSelection(currentTree, selectionPaths);
  });

  function syncTreeHeight(currentTree: FileTree) {
    treeHeight = Math.max(1, currentTree.getVisibleCount()) * currentTree.getItemHeight();
  }

  function handleSelectionChange(selectedPaths: readonly string[]) {
    if (syncingSelection) {
      return;
    }

    const selectedPath = selectedPaths[selectedPaths.length - 1];
    if (!selectedPath) {
      return;
    }

    const ref = branchByPath.get(selectedPath) ?? branchByPath.get(selectedPath.replace(/\/$/, ""));
    if (ref) {
      onSelectRef?.(ref);
    }
  }

  function syncSelection(currentTree: FileTree, selectionPaths: ReadonlySet<string>) {
    const selectedPaths = [...selectionPaths];
    const currentSelectedPaths = currentTree.getSelectedPaths();

    if (
      currentSelectedPaths.length === selectedPaths.length &&
      currentSelectedPaths.every((path) => selectionPaths.has(path))
    ) {
      return;
    }

    syncingSelection = true;
    try {
      for (const currentSelectedPath of currentSelectedPaths) {
        currentTree.getItem(currentSelectedPath)?.deselect();
      }

      for (const selectedPath of selectedPaths) {
        currentTree.getItem(selectedPath)?.select();
      }
    } finally {
      queueMicrotask(() => {
        syncingSelection = false;
      });
    }
  }

  function renderRowDecoration({ item, row }: { item: { path: string }; row: { kind: string } }) {
    const path = normalizePath(item.path);
    const ref = branchByPath.get(path);

    if (ref && isCurrentBranchRef(ref, currentBranch)) {
      return {
        icon: "gitgui-current",
        title: "Current branch — always shown in the graph",
      };
    }

    const affectedRefs = refsForPath(path, row.kind === "directory");
    if (!affectedRefs.length) {
      return null;
    }

    const anyVisible = affectedRefs.some(isRefVisible);
    return {
      icon: anyVisible ? "gitgui-eye" : "gitgui-eye-off",
      title: anyVisible ? "Hide from graph" : "Show in graph",
    };
  }

  function handleDecorationPointerDown(event: PointerEvent) {
    const path = event.composedPath();
    if (!isDecorationEvent(path)) {
      return;
    }

    const item = path.find(
      (value) => value instanceof Element && value.getAttribute("data-type") === "item",
    );
    if (!(item instanceof Element)) {
      return;
    }

    const itemPath = normalizePath(item.getAttribute("data-item-path") ?? "");
    const affectedRefs = refsForPath(itemPath, item.getAttribute("data-item-type") === "folder");
    if (!affectedRefs.length) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const shouldShow = !affectedRefs.some(isRefVisible);
    onToggleRefs?.(affectedRefs, shouldShow);
  }

  function handleTreeClick(event: MouseEvent) {
    const eventPath = event.composedPath();
    if (isDecorationEvent(eventPath)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const item = eventPath.find(
      (value) => value instanceof Element && value.getAttribute("data-type") === "item",
    );
    if (
      event.button !== 0 ||
      !(item instanceof Element) ||
      item.getAttribute("data-item-type") !== "file"
    ) {
      return;
    }

    const itemPath = normalizePath(item.getAttribute("data-item-path") ?? "");
    const alreadySelected = tree
      ?.getSelectedPaths()
      .some((selectedPath) => normalizePath(selectedPath) === itemPath);
    const ref = branchByPath.get(itemPath);
    if (!alreadySelected || !ref) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    onSelectRef?.(ref);
  }

  function handleTreeDoubleClick(event: MouseEvent) {
    const eventPath = event.composedPath();
    if (refType !== "localBranch" || isDecorationEvent(eventPath)) {
      return;
    }

    const item = eventPath.find(
      (value) => value instanceof Element && value.getAttribute("data-type") === "item",
    );
    if (
      event.button !== 0 ||
      !(item instanceof Element) ||
      item.getAttribute("data-item-type") !== "file"
    ) {
      return;
    }

    const itemPath = normalizePath(item.getAttribute("data-item-path") ?? "");
    const ref = branchByPath.get(itemPath);
    if (!ref) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    onSwitchBranch?.(ref.shortName);
  }

  function isDecorationEvent(path: EventTarget[]) {
    return path.some(
      (value) => value instanceof Element && value.getAttribute("data-item-section") === "decoration",
    );
  }

  function refsForPath(path: string, isDirectory: boolean) {
    if (!path) {
      return [];
    }

    return branchRefs.filter((ref) => ref.shortName === path || (isDirectory && ref.shortName.startsWith(`${path}/`)));
  }

  function isRefVisible(ref: CommitRef) {
    return visibleRefKeys.has(graphRefKey(ref)) || isCurrentBranchRef(ref, currentBranch);
  }

  function normalizePath(path: string) {
    return path.replace(/\/$/, "");
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
  role="group"
  aria-label={`${refType === "localBranch" ? "Local" : "Remote"} branches`}
  onpointerdowncapture={handleDecorationPointerDown}
  onclickcapture={handleTreeClick}
  ondblclickcapture={handleTreeDoubleClick}
  style={`height: ${treeHeight}px; --trees-bg-override: var(--app-theme-sidebar); --trees-fg-override: var(--app-theme-sidebar-foreground); --trees-fg-muted-override: var(--app-theme-sidebar-muted-foreground); --trees-border-color-override: var(--app-theme-sidebar-border); --trees-selected-bg-override: var(--app-theme-sidebar-row-active); --trees-selected-fg-override: var(--app-theme-accent-surface-foreground); --trees-accent-override: var(--app-theme-accent); --trees-focus-ring-color-override: var(--app-theme-focus); --trees-font-family-override: inherit; --trees-font-size-override: 13px; --trees-padding-inline-override: 0px; --trees-item-padding-x-override: 3px; --trees-item-row-gap-override: 3px; --trees-level-gap-override: 6px; --trees-item-height: 26px;`}
></div>
