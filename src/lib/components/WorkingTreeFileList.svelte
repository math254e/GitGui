<script lang="ts">
  import { FileTree, type GitStatus, type GitStatusEntry } from "@pierre/trees";
  import { Minus, Plus } from "@lucide/svelte";
  import { onMount } from "svelte";
  import type { ChangedFile } from "$lib/generated/protocol";
  import type { CommitFile } from "$lib/types/repository";

  type Props = {
    files: ChangedFile[];
    selectedPaths: string[];
    treeId: string;
    actionLabel: "Stage" | "Unstage";
    onSelectFile: (file: CommitFile, selectedFiles: ChangedFile[]) => void;
    onSelectionChange: (files: ChangedFile[]) => void;
    onAction: (file: ChangedFile) => void;
    disabled?: boolean;
  };

  type TreeFile = {
    file: ChangedFile;
    path: string;
  };

  let {
    files,
    selectedPaths,
    treeId,
    actionLabel,
    onSelectFile,
    onSelectionChange,
    onAction,
    disabled = false,
  }: Props = $props();

  let host = $state<HTMLDivElement | null>(null);
  let tree = $state<FileTree | null>(null);
  let lastTreeSignature = $state("");
  let scrollTop = $state(0);
  let syncingSelection = false;
  let fileByTreePath = new Map<string, ChangedFile>();
  let scrollElement: HTMLElement | null = null;

  const fileIconTokens = [
    "astro",
    "babel",
    "bash",
    "biome",
    "bootstrap",
    "browserslist",
    "bun",
    "c",
    "cpp",
    "claude",
    "css",
    "database",
    "docker",
    "eslint",
    "git",
    "go",
    "graphql",
    "html",
    "image",
    "javascript",
    "json",
    "markdown",
    "mcp",
    "npm",
    "oxc",
    "postcss",
    "prettier",
    "python",
    "react",
    "ruby",
    "rust",
    "sass",
    "svelte",
    "svgo",
    "swift",
    "table",
    "text",
    "tailwind",
    "terraform",
    "typescript",
    "vite",
    "vscode",
    "vue",
    "wasm",
    "webpack",
    "yml",
    "zig",
    "zip",
  ];
  const fileIconColorOverrides = fileIconTokens
    .map(
      (token) =>
        `[data-item-git-status] > [data-item-section="icon"] [data-icon-token="${token}"] { color: var(--trees-file-icon-color-${token}); }`,
    )
    .join("\n");

  const treeFiles = $derived(files.map((file, index) => ({ file, path: treePathFor(file, index) })));
  const treePaths = $derived(treeFiles.map((entry) => entry.path));
  const treeStatus = $derived(treeFiles.map(toGitStatusEntry));
  const selectedTreePaths = $derived(
    treeFiles.filter((entry) => selectedPaths.includes(entry.file.path)).map((entry) => entry.path),
  );

  onMount(() => {
    if (!host) {
      return;
    }

    tree = new FileTree({
      id: treeId,
      paths: treePaths,
      initialExpansion: "open",
      initialSelectedPaths: selectedTreePaths,
      density: "compact",
      itemHeight: 28,
      icons: {
        set: "complete",
        colored: true,
      },
      gitStatus: treeStatus,
      renderRowDecoration: ({ item }) => {
        const file = fileByTreePath.get(item.path);
        return file ? { text: file.path, title: fileTitle(file) } : null;
      },
      onSelectionChange: handleSelectionChange,
      unsafeCSS: `
        [data-type="item"] {
          margin-right: 13px;
          padding-right: 0;
        }

        [data-type="item"][data-item-focused="true"]::before,
        [data-type="item"]:focus-visible::before {
          outline: none;
        }

        [data-item-section="icon"] {
          flex: none;
          width: 20px;
        }

        [data-item-section="icon"] > svg {
          width: 18px;
          height: 18px;
        }

        [data-item-section="spacing"] {
          display: none;
        }

        [data-item-section="content"] {
          display: none;
        }

        [data-item-section="decoration"] {
          flex: 1 1 auto;
          min-width: 0;
          max-width: none;
          justify-content: flex-start;
          text-align: start;
        }

        [data-item-section="decoration"] > span {
          display: block;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        [data-item-section="git"] {
          flex: none;
          width: 22px;
          box-sizing: border-box;
          justify-content: flex-end;
          padding-right: 10px;
        }

        [data-item-section="git"] > span {
          width: auto;
        }

        ${fileIconColorOverrides}
      `,
    });
    tree.render({ fileTreeContainer: host });

    scrollElement = host.shadowRoot?.querySelector<HTMLElement>("[data-file-tree-virtualized-scroll]") ?? null;
    scrollElement?.addEventListener("scroll", handleScroll, { passive: true });
    scrollTop = scrollElement?.scrollTop ?? 0;

    return () => {
      scrollElement?.removeEventListener("scroll", handleScroll);
      scrollElement = null;
      tree?.cleanUp();
      tree = null;
    };
  });

  $effect(() => {
    const currentTree = tree;
    const nextFiles = treeFiles;

    fileByTreePath = new Map(nextFiles.map((entry) => [entry.path, entry.file]));

    const signature = nextFiles
      .map((entry) => `${entry.path}\0${entry.file.path}\0${entry.file.originalPath ?? ""}\0${entry.file.indexStatus}${entry.file.worktreeStatus}`)
      .join("\0");

    if (!currentTree || signature === lastTreeSignature) {
      return;
    }

    currentTree.resetPaths(treePaths);
    currentTree.setGitStatus(treeStatus);
    syncSelection(currentTree, selectedTreePaths);
    lastTreeSignature = signature;
  });

  $effect(() => {
    const currentTree = tree;

    if (!currentTree) {
      return;
    }

    syncSelection(currentTree, selectedTreePaths);
  });

  function handleScroll(event: Event) {
    scrollTop = (event.currentTarget as HTMLElement).scrollTop;
  }

  function handleSelectionChange(selectedPaths: readonly string[]) {
    if (syncingSelection) {
      return;
    }

    const selectedFiles = selectedPaths
      .map((path) => fileByTreePath.get(path))
      .filter((file): file is ChangedFile => Boolean(file));
    const selectedPath = selectedPaths[selectedPaths.length - 1];
    const file = selectedPath ? fileByTreePath.get(selectedPath) : undefined;

    onSelectionChange(selectedFiles);

    if (file) {
      onSelectFile(toCommitFile(file), selectedFiles);
    }
  }

  function syncSelection(currentTree: FileTree, selectedPaths: readonly string[]) {
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

  function treePathFor(file: ChangedFile, index: number) {
    const pathSegments = file.path.split("/");
    const basename = pathSegments.at(-1) ?? file.path;
    const parentPath = pathSegments.slice(0, -1).join("/");
    const identity = `${parentPath}\0${file.originalPath ?? ""}`;
    return `gitgui-working-file-${index}-${encodeURIComponent(identity)}-${basename}`;
  }

  function toCommitFile(file: ChangedFile): CommitFile {
    return {
      path: file.path,
      originalPath: file.originalPath,
      status: `${file.indexStatus}${file.worktreeStatus}`,
    };
  }

  function fileTitle(file: ChangedFile) {
    const status = `${file.indexStatus}${file.worktreeStatus}`;
    return file.originalPath ? `${status}: ${file.originalPath} -> ${file.path}` : `${status}: ${file.path}`;
  }

  function statusFor(file: ChangedFile): GitStatus {
    const status = statusLabel(file);

    switch (status) {
      case "A":
        return "added";
      case "D":
        return "deleted";
      case "R":
      case "C":
        return "renamed";
      case "U":
        return "untracked";
      default:
        return "modified";
    }
  }

  function toGitStatusEntry(entry: TreeFile): GitStatusEntry {
    return {
      path: entry.path,
      status: statusFor(entry.file),
    };
  }

  function statusLabel(file: ChangedFile) {
    if (file.indexStatus === "?" || file.worktreeStatus === "?") {
      return "U";
    }

    return file.worktreeStatus !== "." ? file.worktreeStatus || "?" : file.indexStatus || "?";
  }
</script>

<div class="relative h-full min-h-0 w-full overflow-hidden" role="group" aria-label={`${actionLabel} files`}>
  <div bind:this={host} class="h-full min-h-0 w-full overflow-hidden" style="--trees-bg-override: var(--app-theme-sidebar); --trees-fg-override: var(--app-theme-sidebar-foreground); --trees-fg-muted-override: var(--app-theme-sidebar-muted-foreground); --trees-border-color-override: var(--app-theme-sidebar-border); --trees-selected-bg-override: var(--app-theme-sidebar-row-selected); --trees-selected-fg-override: var(--app-theme-accent-surface-foreground); --trees-accent-override: var(--app-theme-accent); --trees-focus-ring-color-override: var(--app-theme-focus); --trees-status-added-override: #2f9e6f; --trees-status-deleted-override: #e5484d; --trees-status-modified-override: #d09a2e; --trees-status-renamed-override: #8b5cf6; --trees-status-untracked-override: #2f9e6f; --trees-status-ignored-override: var(--app-theme-text-subtle); --trees-border-radius-override: 4px; --trees-font-family-override: inherit; --trees-font-size-override: 13px; --trees-padding-inline-override: 3px; --trees-item-padding-x-override: 3px; --trees-item-row-gap-override: 6px; --trees-level-gap-override: 0px; --trees-icon-width-override: 18px; --trees-item-height: 28px;"></div>

  <div class="pointer-events-none absolute inset-0 overflow-hidden">
    {#each treeFiles as entry, index (entry.path)}
      <button
        aria-label={`${actionLabel} ${entry.file.path}`}
        class="pointer-events-auto absolute right-0 inline-flex h-7 w-7 items-center justify-center rounded bg-[var(--app-theme-sidebar)] text-[var(--app-theme-text-muted)] transition-colors hover:bg-[var(--app-theme-sidebar-row-hover)] hover:text-[var(--app-theme-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)] disabled:cursor-not-allowed disabled:opacity-40"
        disabled={disabled}
        style={`top: ${index * 28 - scrollTop}px`}
        title={`${actionLabel} ${entry.file.path}`}
        type="button"
        onclick={() => onAction(entry.file)}
      >
        {#if actionLabel === "Stage"}
          <Plus aria-hidden="true" size={15} strokeWidth={2.25} />
        {:else}
          <Minus aria-hidden="true" size={15} strokeWidth={2.25} />
        {/if}
      </button>
    {/each}
  </div>
</div>
