<script lang="ts">
  import { FileTree } from "@pierre/trees";
  import { onMount } from "svelte";
  import type { StashInfo } from "@gitgui/contracts";
  import { dismissContextMenu, showContextMenu } from "$lib/contextMenu";
  import { stashMenuItems, type StashCapabilities } from "$lib/workspace/stash-menu";
  import type { StashAction } from "$lib/workspace/stash-operations";

  let { stashes, selectedStash = null, contextKey, capabilities, onSelect, onAction }: {
    stashes: StashInfo[];
    selectedStash?: StashInfo | null;
    contextKey: string | null;
    capabilities: StashCapabilities;
    onSelect: (stash: StashInfo) => void;
    onAction: (action: StashAction, stash: StashInfo) => void;
  } = $props();

  let host = $state<HTMLDivElement | null>(null);
  let tree = $state.raw<FileTree | null>(null);
  let syncingSelection = false;
  let lastSignature = "";
  let destroyed = false;
  const owner = {};
  const stashByPath = $derived(new Map(stashes.map((stash) => [stashPath(stash), stash])));
  const selectedPath = $derived(selectedStash && stashByPath.has(stashPath(selectedStash)) ? stashPath(selectedStash) : null);
  const spriteSheet = `
    <svg aria-hidden="true" width="0" height="0">
      <symbol id="gitgui-stash-icon" viewBox="0 0 24 24" fill="none">
        <rect x="2" y="3" width="20" height="5" rx="1" stroke="currentColor" stroke-width="1.8" />
        <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
      </symbol>
    </svg>
  `;

  // Messages and branch names are labels, never paths: slashes must not create folders.
  function stashPath(stash: StashInfo) {
    return `${stash.selector}-${stash.hash}`;
  }

  $effect(() => { void contextKey; dismissContextMenu(owner); });

  onMount(() => {
    if (!host) return;
    const currentTree = new FileTree({
      id: "gitgui-stashes",
      paths: [...stashByPath.keys()],
      presorted: true,
      initialSelectedPaths: selectedPath ? [selectedPath] : [],
      density: "compact",
      itemHeight: 26,
      icons: {
        set: "minimal", colored: false, spriteSheet,
        remap: { "file-tree-icon-file": "gitgui-stash-icon" },
      },
      unsafeCSS: `
        [data-type="item"] {
          margin-inline: 0;
          border-radius: 0;
          padding-left: 6px;
          padding-right: 6px;
          white-space: nowrap;
        }
        [data-file-tree-virtualized-scroll="true"] { scrollbar-gutter: auto; }
        [data-type="item"][data-item-focused="true"]::before,
        [data-type="item"]:focus-visible::before { outline: none; }
        [data-item-section="content"] { display: none; }
        [data-item-section="decoration"] {
          flex: 1 1 auto;
          min-width: 0;
          color: inherit;
          justify-content: flex-start;
          text-align: left;
        }
        [data-item-section="decoration"] > span {
          display: block;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
      `,
      renderRowDecoration: ({ item }) => {
        const stash = stashByPath.get(item.path);
        return stash ? {
          text: stash.message,
          title: `${stash.selector}: ${stash.message}\nOriginal branch: ${stash.branch ?? "Unknown"}\nBase: ${stash.baseHash}`,
        } : null;
      },
      onSelectionChange: (paths) => {
        if (syncingSelection) return;
        const stash = stashByPath.get(paths.at(-1) ?? "");
        if (stash) onSelect(stash);
      },
    });
    tree = currentTree;
    currentTree.render({ fileTreeContainer: host });
    // The tree uses opaque paths for identity; expose the real label to assistive
    // technology, including rows recreated by virtualization or snapshot refresh.
    const labels = new MutationObserver(syncRowLabels);
    if (host.shadowRoot) labels.observe(host.shadowRoot, {
      childList: true, subtree: true, attributes: true, attributeFilter: ["data-item-path"],
    });
    syncRowLabels();
    return () => {
      destroyed = true;
      dismissContextMenu(owner);
      labels.disconnect();
      currentTree.cleanUp();
      tree = null;
    };
  });

  $effect(() => {
    if (!tree) return;
    const signature = JSON.stringify([contextKey, stashes]);
    if (signature === lastSignature) return;
    syncingSelection = true;
    try {
      tree.resetPaths([...stashByPath.keys()]);
      lastSignature = signature;
      queueMicrotask(syncRowLabels);
    } finally { syncingSelection = false; }
    syncSelection(tree);
  });

  $effect(() => {
    if (!tree) return;
    syncSelection(tree);
  });

  function syncSelection(currentTree: FileTree) {
    const paths = currentTree.getSelectedPaths();
    if (paths.length === Number(selectedPath !== null) && paths.every((path) => path === selectedPath)) return;
    syncingSelection = true;
    try {
      for (const path of paths) currentTree.getItem(path)?.deselect();
      if (selectedPath) currentTree.getItem(selectedPath)?.select();
    } finally { syncingSelection = false; }
  }

  function contextRow(event: Event) {
    return event.composedPath().find((value): value is HTMLElement =>
      value instanceof HTMLElement && value.getAttribute("data-type") === "item" && value.getAttribute("data-item-type") === "file",
    );
  }

  function syncRowLabels() {
    for (const row of host?.shadowRoot?.querySelectorAll<HTMLElement>('[data-type="item"]') ?? []) {
      const stash = stashByPath.get(row.dataset.itemPath ?? "");
      if (stash) row.setAttribute("aria-label", `${stash.selector}: ${stash.message}`);
    }
  }

  function openMenu(row: HTMLElement, position: { x: number; y: number }) {
    const path = row.dataset.itemPath ?? "";
    const stash = stashByPath.get(path);
    if (!stash) return;
    const key = contextKey;
    const captured = { ...stash };
    // Keep the current selection/diff when opening a menu on another stash.
    const menu = showContextMenu(stashMenuItems(capabilities), position, owner, { width: 250 });
    const highlight = document.createElement("style");
    highlight.dataset.stashMenuHighlight = "true";
    highlight.textContent = `[data-type="item"][data-item-path="${CSS.escape(path)}"] {
      background-color: var(--trees-bg-muted);
      --truncate-marker-background-overlay-color: var(--trees-bg-muted);
    }`;
    host?.shadowRoot?.append(highlight);
    void menu.then((action) => {
      highlight.remove();
      if (!destroyed && key === contextKey && stashByPath.has(path) && action && capabilities[action]) onAction(action, captured);
    });
  }

  function handleContextMenu(event: MouseEvent) {
    const row = contextRow(event);
    if (!row) return;
    event.preventDefault();
    openMenu(row, { x: event.clientX, y: event.clientY });
  }

  function handleClick(event: MouseEvent) {
    const row = contextRow(event);
    const path = row?.dataset.itemPath;
    // A selected row must still reopen its details when its diff is visible.
    if (event.button === 0 && path === selectedPath) {
      const stash = stashByPath.get(path);
      if (stash) onSelect(stash);
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    const row = contextRow(event) ?? host?.shadowRoot?.querySelector<HTMLElement>('[data-item-focused="true"][data-item-type="file"]');
    if (!row) return;
    if (event.key === "Enter" && row.dataset.itemPath === selectedPath) {
      event.preventDefault();
      event.stopPropagation();
      const stash = stashByPath.get(selectedPath);
      if (stash) onSelect(stash);
      return;
    }
    if (event.key !== "ContextMenu" && event.key !== "Apps" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = row.getBoundingClientRect();
    openMenu(row, { x: rect.left, y: rect.bottom });
  }
</script>

<div bind:this={host} role="group" aria-label="Stashes"
  class="min-h-0 w-full overflow-hidden"
  onclickcapture={handleClick} oncontextmenu={handleContextMenu} onkeydowncapture={handleKeydown}
  style={`height: ${Math.max(1, stashes.length) * 26}px; --trees-bg-override: var(--app-theme-sidebar); --trees-fg-override: var(--app-theme-sidebar-foreground); --trees-fg-muted-override: var(--app-theme-sidebar-muted-foreground); --trees-border-color-override: var(--app-theme-sidebar-border); --trees-selected-bg-override: var(--app-theme-sidebar-row-active); --trees-selected-fg-override: var(--app-theme-accent-surface-foreground); --trees-accent-override: var(--app-theme-accent); --trees-focus-ring-color-override: var(--app-theme-focus); --trees-font-family-override: inherit; --trees-font-size-override: 13px; --trees-padding-inline-override: 0px; --trees-item-padding-x-override: 3px; --trees-item-row-gap-override: 3px; --trees-level-gap-override: 6px; --trees-item-height: 26px;`}
></div>
