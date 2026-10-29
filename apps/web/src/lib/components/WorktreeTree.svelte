<script lang="ts">
  import { FileTree } from "@pierre/trees";
  import { onMount } from "svelte";
  import type { CommitInfo, WorktreeInfo } from "$lib/types/repository";
  import TreeDetailsHoverCard from "./TreeDetailsHoverCard.svelte";
  import WorktreeHoverDetails from "./WorktreeHoverDetails.svelte";
  import { dismissContextMenu, showContextMenu } from "$lib/contextMenu";
  import { worktreeMenuItems } from "$lib/workspace/worktree-menu";

  type Props = {
    worktrees: WorktreeInfo[];
    commitsByHash?: ReadonlyMap<string, CommitInfo>;
    treeId: string;
    onSwitchWorktree?: (path: string) => void;
    contextKey?: string | null;
    canRenameBranch?: boolean;
    canDeleteBranch?: boolean;
    canRemoveWorktree?: boolean;
    onRenameWorktreeBranch?: (worktree: WorktreeInfo) => void;
    onRemoveWorktree?: (worktree: WorktreeInfo, deleteBranch: boolean) => void;
  };

  type WorktreeEntry = {
    path: string;
    worktree: WorktreeInfo;
  };

  let {
    worktrees,
    commitsByHash = new Map<string, CommitInfo>(),
    treeId,
    onSwitchWorktree,
    contextKey = null,
    canRenameBranch = false,
    canDeleteBranch = false,
    canRemoveWorktree = false,
    onRenameWorktreeBranch,
    onRemoveWorktree,
  }: Props = $props();

  let host = $state<HTMLDivElement | null>(null);
  let tree = $state<FileTree | null>(null);
  let treeHeight = $state(26);
  let lastTreeSignature = $state("");
  const contextMenuOwner = {};
  $effect(() => { void contextKey; dismissContextMenu(contextMenuOwner); });

  const worktreeSpriteSheet = `
    <svg aria-hidden="true" width="0" height="0">
      <symbol id="gitgui-worktree-icon" viewBox="0 0 24 24" fill="none">
        <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
      </symbol>
      <symbol id="gitgui-current-worktree" viewBox="0 0 24 24" fill="none">
        <rect x="3" y="3" width="18" height="18" rx="3" fill="currentColor" />
        <path d="m7 12 3 3 7-7" stroke="var(--trees-bg)" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" />
      </symbol>
    </svg>
  `;

  const entries = $derived(createEntries(worktrees));
  const worktreeByPath = $derived(new Map(entries.map((entry) => [entry.path, entry.worktree])));
  const treePaths = $derived(entries.map((entry) => entry.path));

  onMount(() => {
    if (!host) {
      return;
    }

    tree = new FileTree({
      id: treeId,
      paths: treePaths,
      initialExpansion: "open",
      density: "compact",
      itemHeight: 26,
      icons: {
        set: "minimal",
        colored: false,
        spriteSheet: worktreeSpriteSheet,
        remap: {
          "file-tree-icon-file": "gitgui-worktree-icon",
        },
      },
      unsafeCSS: `
        [data-item-section="decoration"] {
          position: absolute;
          top: 0;
          right: 2px;
          z-index: 4;
          width: 18px;
          height: 100%;
          color: var(--trees-fg-muted);
        }

        [data-type="item"] {
          margin-inline: 0;
          border-radius: 0;
          padding-left: 6px;
          padding-right: 22px;
          white-space: nowrap;
        }

        [data-file-tree-virtualized-scroll="true"] {
          scrollbar-gutter: auto;
        }

        [data-type="item"][data-item-focused="true"]::before,
        [data-type="item"]:focus-visible::before {
          outline: none;
        }

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
          transition: color .12s, opacity .12s;
        }

        [data-type="item"]:hover [data-item-section="decoration"] > span,
        [data-item-section="decoration"] > span:has([data-icon-name="gitgui-current-worktree"]) {
          opacity: 1;
        }

        [data-type="item"]:hover [data-item-section="decoration"] {
          color: var(--trees-accent);
        }
      `,
      renderRowDecoration,
    });
    tree.render({ fileTreeContainer: host });
    syncTreeHeight(tree);
    const unsubscribe = tree.subscribe(() => syncTreeHeight(tree!));

    return () => {
      dismissContextMenu(contextMenuOwner);
      unsubscribe();
      tree?.cleanUp();
      tree = null;
    };
  });

  $effect(() => {
    const currentTree = tree;

    const signature = entries
      .map((entry) => `${entry.path}\0${entry.worktree.current}\0${entry.worktree.path}`)
      .join("\0");
    if (!currentTree || signature === lastTreeSignature) {
      return;
    }

    const expandedPaths = getExpandedPaths(currentTree);
    currentTree.resetPaths(treePaths, {
      initialExpandedPaths: expandedPaths,
    });
    syncTreeHeight(currentTree);
    lastTreeSignature = signature;
  });

  function syncTreeHeight(currentTree: FileTree) {
    treeHeight = Math.max(1, currentTree.getVisibleCount()) * currentTree.getItemHeight();
  }

  function renderRowDecoration({ item, row }: { item: { path: string }; row: { kind: string } }) {
    if (row.kind !== "file") {
      return null;
    }

    const worktree = worktreeByPath.get(normalizePath(item.path));
    if (!worktree?.current) {
      return null;
    }

    return {
      icon: "gitgui-current-worktree",
      title: "Current worktree",
    };
  }

  function handleTreeDoubleClick(event: MouseEvent) {
    const eventPath = event.composedPath();
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

    const worktree = worktreeByPath.get(normalizePath(item.getAttribute("data-item-path") ?? ""));
    if (!worktree) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    onSwitchWorktree?.(worktree.path);
  }

  function contextRow(event: Event) {
    return event.composedPath().find((value): value is HTMLElement => value instanceof HTMLElement && value.getAttribute("data-type") === "item" && value.getAttribute("data-item-type") === "file");
  }

  function openContextMenu(row: HTMLElement, position: { x: number; y: number }) {
    const worktree = worktreeByPath.get(normalizePath(row.getAttribute("data-item-path") ?? ""));
    if (!worktree) return;
    const key = contextKey;
    const menu = showContextMenu(worktreeMenuItems(worktree, { canRename: canRenameBranch, canRemove: canRemoveWorktree, canDeleteBranch }), position, contextMenuOwner, { width: 320 });
    // Keep the menu target visible through refreshes and virtualized row replacements.
    const treePath = row.dataset.itemPath ?? "";
    const highlight = document.createElement("style");
    highlight.textContent = `[data-type="item"][data-item-path="${CSS.escape(treePath)}"] {
      background-color: var(--trees-bg-muted);
      --truncate-marker-background-overlay-color: var(--trees-bg-muted);
    }`;
    host?.shadowRoot?.appendChild(highlight);

    void menu.then((selected) => {
      highlight.remove();
      if (key !== contextKey) return;
      if (selected === "rename") onRenameWorktreeBranch?.(worktree);
      if (selected === "remove-worktree") onRemoveWorktree?.(worktree, false);
      if (selected === "remove-worktree-branch") onRemoveWorktree?.(worktree, true);
    });
  }

  function handleContextMenu(event: MouseEvent) {
    const row = contextRow(event);
    if (!row) return;
    event.preventDefault();
    openContextMenu(row, { x: event.clientX, y: event.clientY });
  }

  function handleContextKey(event: KeyboardEvent) {
    if (event.key !== "ContextMenu" && event.key !== "Apps" && !(event.shiftKey && event.key === "F10")) return;
    const row = contextRow(event) ?? host?.querySelector<HTMLElement>('[data-item-focused="true"][data-item-type="file"]');
    if (!row) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = row.getBoundingClientRect();
    openContextMenu(row, { x: rect.left, y: rect.bottom });
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

  function createEntries(currentWorktrees: WorktreeInfo[]): WorktreeEntry[] {
    const usedPaths = new Set<string>();

    return [...currentWorktrees]
      .sort((left, right) => worktreeLabel(left).localeCompare(worktreeLabel(right)))
      .map((worktree) => {
        const basePath = worktree.branch ?? `detached/${pathBasename(worktree.path) || "worktree"}`;
        let path = basePath;
        let suffix = 2;
        while (usedPaths.has(path)) {
          path = `${basePath} (${suffix++})`;
        }
        usedPaths.add(path);
        return { path, worktree };
      });
  }

  function worktreeLabel(worktree: WorktreeInfo) {
    return worktree.branch ?? `Detached HEAD ${pathBasename(worktree.path)}`;
  }

  function pathBasename(path: string) {
    return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  }
</script>

<div
  bind:this={host}
  class="min-h-0 w-full overflow-hidden"
  role="group"
  aria-label="Worktrees"
  ondblclickcapture={handleTreeDoubleClick}
  oncontextmenu={handleContextMenu}
  onkeydowncapture={handleContextKey}
  style={`height: ${treeHeight}px; --trees-bg-override: var(--app-theme-sidebar); --trees-fg-override: var(--app-theme-sidebar-foreground); --trees-fg-muted-override: var(--app-theme-sidebar-muted-foreground); --trees-border-color-override: var(--app-theme-sidebar-border); --trees-selected-bg-override: var(--app-theme-sidebar-row-active); --trees-selected-fg-override: var(--app-theme-accent-surface-foreground); --trees-accent-override: var(--app-theme-accent); --trees-focus-ring-color-override: var(--app-theme-focus); --trees-font-family-override: inherit; --trees-font-size-override: 13px; --trees-padding-inline-override: 0px; --trees-item-padding-x-override: 3px; --trees-item-row-gap-override: 3px; --trees-level-gap-override: 6px; --trees-item-height: 26px;`}
></div>

<TreeDetailsHoverCard host={tree ? host : null} {contextKey} getItem={(path) => worktreeByPath.get(path)}>
  {#snippet children(worktree)}
    <WorktreeHoverDetails {worktree} commit={worktree.headOid ? commitsByHash.get(worktree.headOid) : undefined} />
  {/snippet}
</TreeDetailsHoverCard>
