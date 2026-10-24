<script lang="ts">
  import { Cloud, Monitor } from "@lucide/svelte";
  import { onDestroy, tick, untrack } from "svelte";
  import { dismissContextMenu, showContextMenu, type ContextMenuItem } from "$lib/contextMenu";
  import { branchMenuItems } from "$lib/workspace/branch-menu";
  import { GraphRenderIndex, visibleRowRange, captureHistoryAnchor, restoreHistoryAnchor } from "$lib/git-graph/viewport";
  import { drawGitGraphCanvas } from "$lib/git-graph/canvas-renderer";
  import { APP_THEME_VARIABLES, GRAPH_THEME_COLOR_ROLES } from "$lib/theme/types";
  import type { CommitInfo, CommitRef, GraphCommit, RepositorySnapshot, StashInfo, WorktreeInfo } from "$lib/types/repository";

  type ColumnId = "branch" | "graph" | "message";
  type HistoryColumn = {
    id: ColumnId;
    label: string;
    width: number;
    visible: boolean;
  };
  type ResizeState = {
    columnId: ColumnId;
    startX: number;
    startWidth: number;
  };
  type GraphRow = {
    commit: CommitInfo;
    graphCommit: GraphCommit;
    stash: StashInfo | null;
  };
  import { stashMenuItems, unsupportedStashActions, type StashCapabilities } from "$lib/workspace/stash-menu";
  import type { StashAction } from "$lib/workspace/stash-operations";
  type Props = {
    selectedStash?: StashInfo | null;
    stashCapabilities?: StashCapabilities;
    onSelectStash?: (stash: StashInfo) => void;
    onStashAction?: (action: StashAction, stash: StashInfo) => void;
    snapshot: RepositorySnapshot | null;
    repositoryId: string | null;
    getRestoredScrollTop: (repositoryId: string) => number;
    selectedCommit: CommitInfo | null;
    changesSelected: boolean;
    scrollToCommit: { id: number; repositoryId: string; hash: string } | null;
    onScrollTopChange: (repositoryId: string, scrollTop: number) => void;
    onScrollCommandHandled: (commandId: number) => void;
    onSelectChanges: () => void;
    onSelectCommit: (commit: CommitInfo) => void;
    onCompareCommitToWorkingTree: (commit: CommitInfo) => void;
    onCreateBranch?: (commit: CommitInfo) => void;
    onRenameBranch?: (branch: CommitRef) => void;
    onDeleteBranch?: (branch: CommitRef) => void;
    canRenameBranch?: boolean;
    canDeleteBranch?: boolean;
    pending?: boolean;
    contextKey?: string | null;
    canRemoveWorktree?: boolean;
    onRemoveWorktree?: (worktree: WorktreeInfo, deleteBranch: boolean) => void;
  };

  const rowHeight = 34;
  const headerHeight = 30;
  const laneGap = 20;
  const graphPadding = 14;
  const dotRadius = 7;
  const lineWidth = 2.5;
  const columnStorageKey = "gitgui.historyColumns.v1";
  const minimumColumnWidth = 24;
  let {
    selectedStash = null, stashCapabilities = unsupportedStashActions, onSelectStash = () => {}, onStashAction = () => {},
    snapshot,
    repositoryId,
    getRestoredScrollTop,
    selectedCommit,
    changesSelected,
    scrollToCommit,
    onScrollTopChange,
    onScrollCommandHandled,
    onSelectChanges,
    onSelectCommit,
    onCompareCommitToWorkingTree,
    onCreateBranch,
    onRenameBranch,
    onDeleteBranch,
    canRenameBranch = false,
    canDeleteBranch = false,
    pending = false,
    contextKey = null,
    canRemoveWorktree = false,
    onRemoveWorktree,
  }: Props = $props();
  let columns = $state<HistoryColumn[]>([
    { id: "branch", label: "Branch", width: 118, visible: true },
    { id: "graph", label: "Graph", width: 92, visible: true },
    { id: "message", label: "Message", width: 520, visible: true },
  ]);
  let resizeState = $state<ResizeState | null>(null);
  let restoredColumns = false;
  let hoveredRowHash = $state<string | null>(null);
  let contextMenuTarget = $state.raw<{ hash: string } | null>(null);
  const contextMenuOwner = {};
  let destroyed = false;
  $effect(() => {
    void contextKey;
    dismissContextMenu(contextMenuOwner);
  });
  let graphViewport = $state<HTMLDivElement | null>(null);
  let graphCanvas = $state<HTMLCanvasElement | null>(null);
  let graphScrollTop = $state(0);
  let graphViewportHeight = $state(0);
  let graphDevicePixelRatio = $state(1);
  let graphThemeRevision = $state(0);
  let previousRows: GraphCommit[] = [];
  let previousHasChanges = false;
  let previousRepositoryId: string | null = null;
  let anchorGeneration = 0;
  let previousHistory: RepositorySnapshot | null = null;
  let lastHandledScrollCommandId: number | null = null;

  $effect(() => {
    if (restoredColumns) {
      return;
    }

    restoredColumns = true;
    const stored = localStorage.getItem(columnStorageKey);

    if (!stored) {
      return;
    }

    try {
      const widths = JSON.parse(stored) as Partial<Record<ColumnId, number>>;
      columns = columns.map((column) => {
        const width = widths[column.id];

        return typeof width === "number" ? { ...column, width: clampColumnWidth(width) } : column;
      });
    } catch {
      localStorage.removeItem(columnStorageKey);
    }
  });

  onDestroy(() => {
    destroyed = true;
    dismissContextMenu(contextMenuOwner);
    window.removeEventListener("pointermove", resizeColumn);
    resizeState = null;
  });

  function openCommitContextMenu(commit: CommitInfo, position: { x: number; y: number }, clickedBranch?: CommitRef) {
    const key = contextKey;
    const stash = snapshot?.stashes.find((entry) => entry.hash === commit.hash);
    if (stash) {
      const captured = { ...stash };
      const target = { hash: stash.hash };
      contextMenuTarget = target;
      void showContextMenu(stashMenuItems(stashCapabilities), position, contextMenuOwner, { width: 250 }).then((action) => {
        if (contextMenuTarget === target) contextMenuTarget = null;
        if (!destroyed && key === contextKey && action && stashCapabilities[action]) onStashAction(action, captured);
      });
      return;
    }
    const branches = clickedBranch ? [clickedBranch] : snapshot?.refs.filter((ref) => ref.refType === "localBranch" && ref.target === commit.hash) ?? [];
    const actionsFor = (branch: CommitRef) => branchMenuItems(branch, {
      canRename: canRenameBranch,
      canDelete: canDeleteBranch,
      canRemoveWorktree,
      worktree: snapshot?.worktrees.find((entry) => entry.branch === branch.shortName),
      checkedOut: snapshot?.status.currentBranch === branch.shortName || (snapshot?.worktrees.some((worktree) => worktree.branch === branch.shortName) ?? false),
    });
    const items: ContextMenuItem[] = [
      { id: "create", label: "Create branch here…", icon: "git-branch", disabled: pending || !onCreateBranch },
      { id: "compare", label: "Compare to working tree", icon: "git-branch" },
    ];
    if (clickedBranch) {
      items.push({ id: "branch-heading", label: clickedBranch.shortName, header: true, separatorBefore: true }, ...actionsFor(clickedBranch));
    } else {
      items.push(...branches.map((branch) => ({ id: branch.name, label: branch.shortName, icon: "git-branch", children: actionsFor(branch) })));
    }
    const menu = showContextMenu(
      items,
      position,
      contextMenuOwner,
      branches.some((branch) => snapshot?.worktrees.some((entry) => entry.branch === branch.shortName && entry.isMain === false)) ? { width: 320 } : undefined,
    );
    const target = { hash: commit.hash };
    contextMenuTarget = target;
    void menu.then((selected) => {
      if (contextMenuTarget === target) contextMenuTarget = null;
      if (key !== contextKey) return;
      if (selected === "compare") {
        onCompareCommitToWorkingTree(commit);
      }
      if (selected === "create") onCreateBranch?.(commit);
      for (const branch of branches) {
        if (selected === `rename:${branch.name}`) onRenameBranch?.(branch);
        if (selected === `delete:${branch.name}`) onDeleteBranch?.(branch);
        const worktree = snapshot?.worktrees.find((entry) => entry.branch === branch.shortName);
        if (worktree && selected === `remove-worktree:${branch.name}`) onRemoveWorktree?.(worktree, false);
        if (worktree && selected === `remove-worktree-branch:${branch.name}`) onRemoveWorktree?.(worktree, true);
      }
    });
  }

  function handleCommitContextMenu(event: MouseEvent, commit: CommitInfo) {
    event.preventDefault();
    const branchName = event.target instanceof Element ? event.target.closest("[data-local-branch]")?.getAttribute("data-local-branch") : null;
    const branch = branchName ? snapshot?.refs.find((ref) => ref.refType === "localBranch" && ref.name === branchName) : undefined;
    openCommitContextMenu(commit, { x: event.clientX, y: event.clientY }, branch);
  }

  function handleCommitKeydown(event: KeyboardEvent, commit: CommitInfo) {
    if (event.key === "ContextMenu" || event.key === "Apps" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const rect = event.currentTarget instanceof HTMLElement ? event.currentTarget.getBoundingClientRect() : null;
      if (rect) {
        openCommitContextMenu(commit, { x: rect.left, y: rect.bottom });
      }
      return;
    }

    navigateHistory(event, commit.hash);
  }

  function captureGraphScroll(viewport: HTMLDivElement, initialRepositoryId: string | null) {
    let observedScrollTop = viewport.scrollTop;
    let currentRepositoryId = initialRepositoryId;
    let restoring = false;
    let restoreGeneration = 0;

    const restoreScrollTop = (nextRepositoryId: string | null) => {
      currentRepositoryId = nextRepositoryId;
      const generation = ++restoreGeneration;

      if (!nextRepositoryId) {
        restoring = false;
        return;
      }

      restoring = true;
      const restoredScrollTop = getRestoredScrollTop(nextRepositoryId);
      setViewportScrollTop(viewport, restoredScrollTop);
      observedScrollTop = viewport.scrollTop;

      void tick().then(() => {
        if (generation !== restoreGeneration || currentRepositoryId !== nextRepositoryId) {
          return;
        }

        setViewportScrollTop(viewport, restoredScrollTop);
        observedScrollTop = viewport.scrollTop;
        restoring = false;
      });
    };

    const captureScrollTop = () => {
      if (restoring || viewport.scrollTop === observedScrollTop) {
        return;
      }

      observedScrollTop = viewport.scrollTop;
      graphScrollTop = viewport.scrollTop;
      if (currentRepositoryId) {
        onScrollTopChange(currentRepositoryId, viewport.scrollTop);
      }
    };

    let scrollFrame = 0;
    const scheduleScroll = () => {
      if (!scrollFrame) scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; captureScrollTop(); });
    };
    viewport.addEventListener("scroll", scheduleScroll, { passive: true });

    restoreScrollTop(initialRepositoryId);

    return {
      update: (nextRepositoryId: string | null) => {
        if (nextRepositoryId !== currentRepositoryId) {
          restoreScrollTop(nextRepositoryId);
        }
      },
      destroy: () => {
        restoreGeneration += 1;
        cancelAnimationFrame(scrollFrame);
        viewport.removeEventListener("scroll", scheduleScroll);
      },
    };
  }

  $effect(() => {
    const viewport = graphViewport;

    if (!viewport) {
      return;
    }

    const measure = () => {
      graphViewportHeight = viewport.clientHeight;
      graphDevicePixelRatio = window.devicePixelRatio || 1;
    };
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    measure();

    return () => observer.disconnect();
  });

  $effect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      graphThemeRevision += 1;
    });
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["class", "data-theme-appearance", "data-theme-id", "style"],
    });

    return () => observer.disconnect();
  });

  const hasChanges = $derived(Boolean(snapshot?.status.changedFiles.length));
  const visibleColumns = $derived(columns.filter((column) => column.visible));
  // Status-only snapshots retain history identity so file edits do not rebuild labels/layout indexes.
  const historySnapshot = $derived(stableHistory(snapshot));
  const graphRows = $derived(buildGraphRows(historySnapshot));
  const renderIndex = $derived(new GraphRenderIndex(historySnapshot?.graph ?? { commits: [], edges: [], width: 1, headLane: null }, historySnapshot?.commits ?? []));
  const rowRange = $derived(visibleRowRange(graphRows.length, graphScrollTop, graphViewportHeight, rowHeight, hasChanges));
  const visibleRows = $derived(graphRows.slice(rowRange.start, rowRange.end));
  const graphCommitByHash = $derived(new Map((historySnapshot?.graph.commits ?? []).map((commit) => [commit.hash, commit])));
  const graphRequiredWidth = $derived(
    Math.max(90, graphPadding * 2 + Math.max(0, (snapshot?.graph.width ?? 1) - 1) * laneGap + dotRadius * 2),
  );
  const graphColumnOffset = $derived(
    visibleColumns
      .slice(0, Math.max(0, visibleColumns.findIndex((column) => column.id === "graph")))
      .reduce((total, column) => total + renderedColumnWidth(column), 0),
  );
  const gridTemplate = $derived(
    visibleColumns
      .map((column) => `${renderedColumnWidth(column)}px`)
      .join(" "),
  );
  const totalGridWidth = $derived(
    visibleColumns.reduce((total, column) => total + renderedColumnWidth(column), 0),
  );
  const refsByTarget = $derived(groupRefsByTarget(historySnapshot?.refs ?? []));
  const branchRefByFirstParentCommit = $derived(groupBranchRefByFirstParentCommit(historySnapshot));
  const branchRefByLineCommit = $derived(groupBranchRefByLineCommit(historySnapshot));
  const branchRefByLaneCommit = $derived(groupBranchRefByLaneCommit(historySnapshot, graphCommitByHash, refsByTarget));
  const branchRefByMergeTargetCommit = $derived(
    groupBranchRefByMergeTargetCommit(historySnapshot, branchRefByFirstParentCommit, branchRefByLaneCommit),
  );
  const nearestDescendantRefs = $derived.by(() => {
    const hashes = [contextMenuTarget?.hash ?? hoveredRowHash, selectedCommit?.hash].filter((hash): hash is string => Boolean(hash) && !branchRefByLineCommit.has(hash!));
    return groupBranchRefByNearestDescendantCommit(historySnapshot, graphCommitByHash, refsByTarget, hashes);
  });
  const commitInfoByHash = $derived(new Map((historySnapshot?.commits ?? []).map((commit) => [commit.hash, commit])));
  const stashHashes = $derived(
    new Set((historySnapshot?.stashes ?? []).map((stash) => stash.hash)),
  );

  $effect.pre(() => {
    const viewport = graphViewport;
    const nextRows = renderIndex.rows;
    const nextHasChanges = hasChanges;
    const nextRepositoryId = repositoryId;
    const generation = ++anchorGeneration;
    if (viewport && nextRepositoryId === previousRepositoryId && (nextRows !== previousRows || nextHasChanges !== previousHasChanges)) {
      const anchor = captureHistoryAnchor(previousRows, untrack(() => viewport.scrollTop), rowHeight, previousHasChanges);
      const nextTop = anchor ? restoreHistoryAnchor(anchor, nextRows, rowHeight, nextHasChanges) : null;
      if (nextTop !== null) void tick().then(() => {
        if (generation === anchorGeneration && graphViewport === viewport && repositoryId === nextRepositoryId) setViewportScrollTop(viewport, nextTop);
      });
    }
    previousRows = nextRows;
    previousHasChanges = nextHasChanges;
    previousRepositoryId = nextRepositoryId;
  });

  $effect(() => {
    const viewport = graphViewport;
    const currentRepositoryId = repositoryId;
    const command = scrollToCommit;
    const rowCount = graphRows.length;

    if (
      !viewport ||
      !currentRepositoryId ||
      !command ||
      command.repositoryId !== currentRepositoryId ||
      !rowCount ||
      command.id === lastHandledScrollCommandId
    ) {
      return;
    }

    const commandId = command.id;
    const targetHash = command.hash;

    void tick().then(() => {
      if (
        graphViewport !== viewport ||
        repositoryId !== currentRepositoryId ||
        scrollToCommit?.repositoryId !== currentRepositoryId ||
        scrollToCommit?.id !== commandId
      ) {
        return;
      }

      const targetIndex = graphRows.findIndex((row) => row.commit.hash === targetHash);
      if (targetIndex < 0) return;
      lastHandledScrollCommandId = commandId;
      const targetTop = (targetIndex + Number(hasChanges)) * rowHeight;
      const centeredTop = targetTop - (viewport.clientHeight - rowHeight) / 2;

      setViewportScrollTop(viewport, centeredTop);
      onScrollCommandHandled(commandId);
    });
  });

  $effect(() => {
    const canvas = graphCanvas;
    const currentSnapshot = snapshot;
    const viewportHeight = graphViewportHeight;
    const scrollTop = graphScrollTop;
    const width = graphRequiredWidth;
    const dpr = graphDevicePixelRatio;
    const selectedHash = selectedCommit?.hash ?? null;
    const hoveredHash = contextMenuTarget?.hash ?? hoveredRowHash;
    const currentStashHashes = stashHashes;
    graphThemeRevision;

    if (!canvas || !currentSnapshot || viewportHeight <= 0 || width <= 0) {
      return;
    }

    const computedStyle = getComputedStyle(canvas);
    const surfaceColor = computedStyle.getPropertyValue("--app-theme-surface").trim() || "#ffffff";
    const graphColors = GRAPH_THEME_COLOR_ROLES.map((role) =>
      computedStyle.getPropertyValue(APP_THEME_VARIABLES[role]).trim(),
    ).filter(Boolean);
    const frame = requestAnimationFrame(() => drawGitGraphCanvas(canvas, {
      graph: currentSnapshot.graph,
      index: renderIndex,
      commits: currentSnapshot.commits,
      headHash: currentSnapshot.status.headOid,
      hasWorkingTreeRow: hasChanges,
      stashHashes: currentStashHashes,
      selectedHash,
      hoveredHash,
      scrollTop,
      viewportHeight,
      width,
      devicePixelRatio: dpr,
      rowHeight,
      laneGap,
      graphPadding,
      dotRadius,
      lineWidth,
      colors: graphColors,
      surfaceColor,
    }));
    return () => cancelAnimationFrame(frame);
  });

  function renderedColumnWidth(column: HistoryColumn | undefined) {
    if (!column) {
      return 0;
    }

    return column.width;
  }

  function clampColumnWidth(width: number) {
    return Math.max(minimumColumnWidth, Math.round(width));
  }

  function persistColumns(nextColumns: HistoryColumn[]) {
    localStorage.setItem(
      columnStorageKey,
      JSON.stringify(Object.fromEntries(nextColumns.map((column) => [column.id, column.width]))),
    );
  }

  function buildGraphRows(currentSnapshot: RepositorySnapshot | null): GraphRow[] {
    if (!currentSnapshot) {
      return [];
    }

    const commits = new Map(currentSnapshot.commits.map((commit) => [commit.hash, commit]));
    const stashes = new Map<string, StashInfo>();
    for (const stash of currentSnapshot.stashes ?? []) {
      // A graph object has one row even when the reflog stores it repeatedly.
      // Match the latest entry used by the row's reviewed context menu.
      if (!stashes.has(stash.hash)) stashes.set(stash.hash, stash);
    }

    return [...currentSnapshot.graph.commits]
      .sort((first, second) => first.row - second.row)
      .flatMap((graphCommit) => {
        const commit = commits.get(graphCommit.hash);
        return commit
          ? [{ commit, graphCommit, stash: stashes.get(commit.hash) ?? null }]
          : [];
      });
  }

  function groupRefsByTarget(refs: CommitRef[]) {
    const grouped = new Map<string, CommitRef[]>();

    for (const ref of refs) {
      const refsForTarget = grouped.get(ref.target) ?? [];
      refsForTarget.push(ref);
      grouped.set(ref.target, refsForTarget);
    }

    for (const refsForTarget of grouped.values()) {
      const dedupedRefs = dedupeRemoteRefsWhenLocalExists(refsForTarget);
      refsForTarget.splice(0, refsForTarget.length, ...dedupedRefs);
      refsForTarget.sort((first, second) => refRank(first) - refRank(second) || displayRefName(first).localeCompare(displayRefName(second)));
    }

    return grouped;
  }

  function refRank(ref: CommitRef) {
    if (ref.refType === "localBranch") {
      return 0;
    }

    if (ref.refType === "remoteBranch") {
      return 1;
    }

    return 2;
  }

  function stableHistory(next: RepositorySnapshot | null) {
    if (next && previousHistory && next.commits === previousHistory.commits && next.graph === previousHistory.graph && next.refs === previousHistory.refs && next.stashes === previousHistory.stashes && next.status.currentBranch === previousHistory.status.currentBranch) return previousHistory;
    previousHistory = next;
    return next;
  }

  function groupBranchRefByFirstParentCommit(currentSnapshot: RepositorySnapshot | null) {
    const grouped = new Map<string, CommitRef>();
    if (!currentSnapshot) return grouped;
    const commits = new Map(currentSnapshot.commits.map((commit) => [commit.hash, commit]));
    const refs = currentSnapshot.refs.filter((ref) => ref.refType !== "tag").sort((a, b) => {
      const current = currentSnapshot.status.currentBranch;
      return Number(displayRefName(b) === current) - Number(displayRefName(a) === current)
        || refRank(a) - refRank(b)
        || (commits.get(b.target)?.timestamp ?? 0) - (commits.get(a.target)?.timestamp ?? 0)
        || displayRefName(a).localeCompare(displayRefName(b));
    });
    for (const ref of refs) {
      let hash: string | undefined = ref.target;
      while (hash && commits.has(hash) && !grouped.has(hash)) {
        grouped.set(hash, ref);
        hash = commits.get(hash)?.parents[0];
      }
    }
    return grouped;
  }

  function bestBranchRef(refs: CommitRef[], currentSnapshot: RepositorySnapshot) {
    const commitByHash = commitInfoByHash;
    const currentBranch = currentSnapshot.status.currentBranch;
    const rankedRefs = [...refs].sort((first, second) => {
      if (currentBranch) {
        const firstIsCurrent = displayRefName(first) === currentBranch;
        const secondIsCurrent = displayRefName(second) === currentBranch;

        if (firstIsCurrent !== secondIsCurrent) {
          return firstIsCurrent ? -1 : 1;
        }
      }

      const rankDelta = refRank(first) - refRank(second);

      if (rankDelta !== 0) {
        return rankDelta;
      }

      const firstTime = commitByHash.get(first.target)?.timestamp ?? 0;
      const secondTime = commitByHash.get(second.target)?.timestamp ?? 0;

      return secondTime - firstTime || displayRefName(first).localeCompare(displayRefName(second));
    });

    return rankedRefs[0] ?? null;
  }

  function bestBranchNameRef(refs: CommitRef[], currentSnapshot: RepositorySnapshot) {
    const commitByHash = commitInfoByHash;

    return [...refs].sort((first, second) => {
      const firstTime = commitByHash.get(first.target)?.timestamp ?? 0;
      const secondTime = commitByHash.get(second.target)?.timestamp ?? 0;

      return secondTime - firstTime || refRank(first) - refRank(second) || displayRefName(first).localeCompare(displayRefName(second));
    })[0] ?? null;
  }

  function groupBranchRefByLineCommit(currentSnapshot: RepositorySnapshot | null) {
    type BranchLabel = {
      ref: CommitRef;
      score: number;
      sticky: boolean;
    };

    const grouped = new Map<string, CommitRef>();

    if (!currentSnapshot) {
      return grouped;
    }

    const commitByHash = new Map(currentSnapshot.commits.map((commit) => [commit.hash, commit]));
    const firstParentChildrenByParent = new Map<string, CommitInfo[]>();
    const branchRefs = currentSnapshot.refs.filter((ref) => ref.refType !== "tag" && commitByHash.has(ref.target));
    const refsByName = new Map<string, CommitRef[]>();
    const labelsByCommit = new Map<string, BranchLabel[]>();

    for (const commit of currentSnapshot.commits) {
      const firstParentHash = commit.parents[0];

      if (firstParentHash && commitByHash.has(firstParentHash)) {
        const children = firstParentChildrenByParent.get(firstParentHash) ?? [];
        children.push(commit);
        firstParentChildrenByParent.set(firstParentHash, children);
      }
    }

    for (const ref of branchRefs) {
      const name = displayRefName(ref);
      const refsForName = refsByName.get(name) ?? [];
      refsForName.push(ref);
      refsByName.set(name, refsForName);
      addBranchLabel(labelsByCommit, ref.target, ref, 0, false);
    }

    const branchRefByName = new Map(
      [...refsByName].map(([name, refs]) => [name, bestBranchNameRef(dedupeRemoteRefsWhenLocalExists(refs), currentSnapshot)]),
    );

    for (const commit of currentSnapshot.commits) {
      const mergeNames = parseMergeBranchNames(commit.message);
      const targetRef = mergeNames.target ? branchRefByName.get(mergeNames.target) : null;

      if (targetRef) {
        addBranchLabel(labelsByCommit, commit.hash, targetRef, 0, true);
      }

      const currentLabels = targetRef
        ? [{ ref: targetRef, score: 0, sticky: true }]
        : [...(labelsByCommit.get(commit.hash) ?? [])].sort(compareBranchLabels);

      if (!currentLabels.length) {
        continue;
      }

      const firstParentHash = commit.parents[0];

      if (firstParentHash && commitByHash.has(firstParentHash)) {
        const firstParentChildCount = firstParentChildrenByParent.get(firstParentHash)?.length ?? 0;
        const crossesBranchPoint = firstParentChildCount > 1;

        for (const label of currentLabels) {
          if (label.sticky || !crossesBranchPoint) {
            addBranchLabel(labelsByCommit, firstParentHash, label.ref, label.score + 1, label.sticky);
          }
        }
      }

      if (commit.parents.length < 2) {
        continue;
      }

      const sourceRef = mergeNames.source ? branchRefByName.get(mergeNames.source) : null;
      const hasNamedCurrentLabel = currentLabels.some((label) => !isMainBranchRef(label.ref));

      for (const mergedParentHash of commit.parents.slice(1)) {
        if (!commitByHash.has(mergedParentHash)) {
          continue;
        }

        if (sourceRef && !(isMainBranchRef(sourceRef) && hasNamedCurrentLabel && !targetRef)) {
          addBranchLabel(labelsByCommit, mergedParentHash, sourceRef, currentLabels[0].score + 1, true);
          continue;
        }

        for (const label of currentLabels) {
          addBranchLabel(labelsByCommit, mergedParentHash, label.ref, label.score + 2, true);
        }
      }
    }

    for (const [hash, labels] of labelsByCommit) {
      const branchRef = chooseBranchLabel(labels)?.ref;

      if (branchRef) {
        grouped.set(hash, branchRef);
      }
    }

    return grouped;
  }

  function addBranchLabel(
    labelsByCommit: Map<string, { ref: CommitRef; score: number; sticky: boolean }[]>,
    hash: string,
    ref: CommitRef,
    score: number,
    sticky: boolean,
  ) {
    const labels = labelsByCommit.get(hash) ?? [];
    const existing = labels.find((label) => displayRefName(label.ref) === displayRefName(ref));

    if (existing) {
      if (score < existing.score) {
        existing.score = score;
        existing.ref = ref;
      }

      existing.sticky = existing.sticky || sticky;
    } else {
      labels.push({ ref, score, sticky });
      labelsByCommit.set(hash, labels);
    }
  }

  function chooseBranchLabel(labels: { ref: CommitRef; score: number; sticky: boolean }[]) {
    const namedLabels = labels.filter((label) => !isMainBranchRef(label.ref));
    const candidates = namedLabels.length ? namedLabels : labels;

    return [...candidates].sort(compareBranchLabels)[0] ?? null;
  }

  function compareBranchLabels(
    first: { ref: CommitRef; score: number; sticky: boolean },
    second: { ref: CommitRef; score: number; sticky: boolean },
  ) {
    if (first.sticky !== second.sticky) {
      return first.sticky ? -1 : 1;
    }

    return first.score - second.score || refRank(first.ref) - refRank(second.ref) || displayRefName(first.ref).localeCompare(displayRefName(second.ref));
  }

  function parseMergeBranchNames(message: string) {
    const explicitTargetMatch = message.match(/^Merge (?:remote-tracking )?branch ['"](?:origin\/)?([^'"]+)['"] into ([^\s]+)/i);

    if (explicitTargetMatch) {
      return {
        source: explicitTargetMatch[1],
        target: explicitTargetMatch[2],
      };
    }

    const sourceMatch = message.match(/^Merge (?:remote-tracking )?branch ['"](?:origin\/)?([^'"]+)['"]/i);

    return {
      source: sourceMatch?.[1],
      target: undefined,
    };
  }

  function groupBranchRefByNearestDescendantCommit(
    currentSnapshot: RepositorySnapshot | null,
    graphCommits: Map<string, GraphCommit>,
    refsByCommit: Map<string, CommitRef[]>,
    targetHashes: string[],
  ) {
    const grouped = new Map<string, CommitRef>();

    if (!currentSnapshot || !targetHashes.length) {
      return grouped;
    }

    const commitByHash = new Map(currentSnapshot.commits.map((commit) => [commit.hash, commit]));
    const firstParentChildrenByParent = new Map<string, CommitInfo[]>();

    for (const commit of currentSnapshot.commits) {
      const firstParentHash = commit.parents[0];

      if (firstParentHash) {
        const children = firstParentChildrenByParent.get(firstParentHash) ?? [];
        children.push(commit);
        firstParentChildrenByParent.set(firstParentHash, children);
      }
    }

    for (const children of firstParentChildrenByParent.values()) {
      children.sort((first, second) => {
        const firstRow = graphCommits.get(first.hash)?.row ?? Number.MAX_SAFE_INTEGER;
        const secondRow = graphCommits.get(second.hash)?.row ?? Number.MAX_SAFE_INTEGER;
        return firstRow - secondRow || second.timestamp - first.timestamp;
      });
    }

    for (const hash of targetHashes) {
      const commit = commitByHash.get(hash);
      if (!commit) continue;
      const startGraphCommit = graphCommits.get(commit.hash);
      const candidates: Array<{ ref: CommitRef; target: string; distance: number }> = [];
      const seen = new Set<string>([commit.hash]);
      const queue: Array<{ hash: string; distance: number }> = (firstParentChildrenByParent.get(commit.hash) ?? []).map((child) => ({
        hash: child.hash,
        distance: 1,
      }));
      let closestDistance: number | null = null;

      for (let cursor = 0; cursor < queue.length; cursor++) {
        const item = queue[cursor];

        if (!item || seen.has(item.hash)) {
          continue;
        }

        seen.add(item.hash);

        if (closestDistance !== null && item.distance > closestDistance + 3) {
          continue;
        }

        const branchRefs = (refsByCommit.get(item.hash) ?? []).filter((ref) => ref.refType !== "tag");

        if (branchRefs.length) {
          closestDistance = closestDistance ?? item.distance;
          for (const ref of dedupeRemoteRefsWhenLocalExists(branchRefs)) {
            candidates.push({ ref, target: item.hash, distance: item.distance });
          }
        }

        for (const child of firstParentChildrenByParent.get(item.hash) ?? []) {
          if (!seen.has(child.hash)) {
            queue.push({ hash: child.hash, distance: item.distance + 1 });
          }
        }
      }

      if (!candidates.length) {
        continue;
      }

      candidates.sort((first, second) => {
        const firstIsNamed = !isMainBranchRef(first.ref);
        const secondIsNamed = !isMainBranchRef(second.ref);

        if (firstIsNamed !== secondIsNamed) {
          return firstIsNamed ? -1 : 1;
        }

        const firstLane = graphCommits.get(first.target)?.lane;
        const secondLane = graphCommits.get(second.target)?.lane;
        const firstLaneDelta = startGraphCommit && firstLane !== undefined ? Math.abs(firstLane - startGraphCommit.lane) : Number.MAX_SAFE_INTEGER;
        const secondLaneDelta = startGraphCommit && secondLane !== undefined ? Math.abs(secondLane - startGraphCommit.lane) : Number.MAX_SAFE_INTEGER;

        if (firstLaneDelta !== secondLaneDelta) {
          return firstLaneDelta - secondLaneDelta;
        }

        if (first.distance !== second.distance) {
          return first.distance - second.distance;
        }

        return refRank(first.ref) - refRank(second.ref) || displayRefName(first.ref).localeCompare(displayRefName(second.ref));
      });

      const branchRef = candidates[0]?.ref;

      if (branchRef && commitByHash.has(commit.hash)) {
        grouped.set(commit.hash, branchRef);
      }
    }

    return grouped;
  }

  function groupBranchRefByLaneCommit(
    currentSnapshot: RepositorySnapshot | null,
    graphCommits: Map<string, GraphCommit>,
    refsByCommit: Map<string, CommitRef[]>,
  ) {
    const grouped = new Map<string, CommitRef>();

    if (!currentSnapshot) {
      return grouped;
    }

    const sortedGraphCommits = [...graphCommits.values()].sort((first, second) => first.row - second.row);
    const laneRefs = new Map<number, CommitRef>();

    for (const graphCommit of sortedGraphCommits) {
      const directBranchRefs = (refsByCommit.get(graphCommit.hash) ?? []).filter((ref) => ref.refType !== "tag");

      if (directBranchRefs.length) {
        const branchRef = bestBranchRef(directBranchRefs, currentSnapshot);

        if (branchRef) {
          laneRefs.set(graphCommit.lane, branchRef);
          grouped.set(graphCommit.hash, branchRef);
          continue;
        }
      }

      const laneRef = laneRefs.get(graphCommit.lane);

      if (laneRef) {
        grouped.set(graphCommit.hash, laneRef);
      }
    }

    return grouped;
  }

  function groupBranchRefByMergeTargetCommit(
    currentSnapshot: RepositorySnapshot | null,
    firstParentRefs: Map<string, CommitRef>,
    laneRefs: Map<string, CommitRef>,
  ) {
    const grouped = new Map<string, CommitRef>();

    if (!currentSnapshot) {
      return grouped;
    }

    const commitByHash = new Map(currentSnapshot.commits.map((commit) => [commit.hash, commit]));

    for (const mergeCommit of [...currentSnapshot.commits].reverse()) {
      if (mergeCommit.parents.length < 2) {
        continue;
      }

      const targetRef = firstParentRefs.get(mergeCommit.hash) ?? laneRefs.get(mergeCommit.hash);

      if (!targetRef) {
        continue;
      }

      for (const mergedParentHash of mergeCommit.parents.slice(1)) {
        let hash: string | undefined = mergedParentHash;
        const seen = new Set<string>();

        while (hash && !seen.has(hash) && !firstParentRefs.has(hash) && !grouped.has(hash)) {
          seen.add(hash);
          grouped.set(hash, targetRef);

          hash = commitByHash.get(hash)?.parents[0];
        }
      }
    }

    return grouped;
  }

  function dedupeRemoteRefsWhenLocalExists(refs: CommitRef[]) {
    const localNames = new Set(
      refs
        .filter((ref) => ref.refType === "localBranch")
        .map((ref) => `${displayRefName(ref)}\0${ref.target}`),
    );

    return refs.filter((ref) => ref.refType !== "remoteBranch" || !localNames.has(`${displayRefName(ref)}\0${ref.target}`));
  }

  function displayRefName(ref: CommitRef) {
    if (ref.refType !== "remoteBranch") {
      return ref.shortName;
    }

    const slashIndex = ref.shortName.indexOf("/");
    return slashIndex === -1 ? ref.shortName : ref.shortName.slice(slashIndex + 1);
  }

  function isMainBranchRef(ref: CommitRef) {
    return ref.refType !== "tag" && displayRefName(ref) === "main";
  }

  function branchColor(lane: number) {
    const role = GRAPH_THEME_COLOR_ROLES[lane % GRAPH_THEME_COLOR_ROLES.length];
    return `var(${APP_THEME_VARIABLES[role]})`;
  }

  function refBadgeStyle(refType: CommitRef["refType"], graphCommit: GraphCommit | undefined) {
    const color = branchColor(graphCommit?.lane ?? 0);
    const tint = refType === "tag" ? 18 : refType === "remoteBranch" ? 22 : 26;

    return [
      `border-color: color-mix(in srgb, ${color} 72%, var(--app-theme-border, #d4d4d8))`,
      `color: var(--app-theme-text, #27272a)`,
      `background: color-mix(in srgb, ${color} ${tint}%, var(--app-theme-surface, #ffffff))`,
    ].join("; ");
  }

  function refKey(ref: CommitRef) {
    return `${ref.refType}\0${ref.name}\0${ref.target}`;
  }

  function startResize(event: PointerEvent, column: HistoryColumn) {
    event.preventDefault();
    resizeState = {
      columnId: column.id,
      startX: event.clientX,
      startWidth: column.width,
    };
    window.addEventListener("pointermove", resizeColumn);
    window.addEventListener("pointerup", stopResize, { once: true });
  }

  function resizeColumn(event: PointerEvent) {
    if (!resizeState) {
      return;
    }

    columns = columns.map((column) => {
      if (column.id !== resizeState?.columnId) {
        return column;
      }

      const nextWidth = clampColumnWidth(resizeState.startWidth + event.clientX - resizeState.startX);
      return { ...column, width: Math.round(nextWidth) };
    });
  }

  function stopResize() {
    persistColumns(columns);
    resizeState = null;
    window.removeEventListener("pointermove", resizeColumn);
  }

  function setViewportScrollTop(viewport: HTMLDivElement, scrollTop: number) {
    const maximumScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    viewport.scrollTop = Math.max(0, Math.min(scrollTop, maximumScrollTop));
    graphScrollTop = viewport.scrollTop;
  }

  function navigateHistory(event: KeyboardEvent, hash: string | null) {
    if (event.altKey || event.ctrlKey || event.metaKey || !graphViewport) return;
    const count = graphRows.length + Number(hasChanges);
    const current = hash === null ? 0 : graphRows.findIndex((row) => row.commit.hash === hash) + Number(hasChanges);
    const page = Math.max(1, Math.floor(graphViewportHeight / rowHeight) - 1);
    const next = event.key === "ArrowDown" ? current + 1 : event.key === "ArrowUp" ? current - 1
      : event.key === "PageDown" ? current + page : event.key === "PageUp" ? current - page
      : event.key === "Home" ? 0 : event.key === "End" ? count - 1 : null;
    if (next === null || !count) return;
    event.preventDefault();
    const index = Math.max(0, Math.min(count - 1, next));
    const row = graphRows[index - Number(hasChanges)];
    if (row?.stash) onSelectStash(row.stash); else if (row) onSelectCommit(row.commit); else onSelectChanges();
    const viewport = graphViewport;
    const top = index * rowHeight;
    if (top < viewport.scrollTop) setViewportScrollTop(viewport, top);
    else if (top + rowHeight > viewport.scrollTop + viewport.clientHeight) setViewportScrollTop(viewport, top + rowHeight - viewport.clientHeight);
    void tick().then(() => {
      if (graphViewport !== viewport) return;
      const target = row
        ? [...viewport.querySelectorAll<HTMLButtonElement>("[data-commit-hash]")].find((button) => button.dataset.commitHash === row.commit.hash)
        : viewport.querySelector<HTMLButtonElement>("[data-working-tree]");
      target?.focus({ preventScroll: true });
    });
  }

</script>

<section class="h-full min-h-0 bg-[var(--app-theme-surface)]">
  {#if snapshot}
    <div class="flex h-full min-h-0 flex-col">
      <div
        class="grid border-b border-[var(--app-theme-toolbar-border)] bg-[var(--app-theme-toolbar)] text-[11px] font-bold uppercase text-[var(--app-theme-toolbar-foreground)]"
        style={`grid-template-columns: ${gridTemplate}; min-width: ${totalGridWidth}px; height: ${headerHeight}px;`}
      >
        {#each visibleColumns as column, index (column.id)}
          <div class="relative flex items-center border-r border-[var(--app-theme-toolbar-border)] px-1 last:border-r-0">
            <span class="truncate">{column.label}</span>
            {#if index < visibleColumns.length - 1}
              <button
                class="absolute top-0 right-[-4px] z-30 h-full w-2 cursor-col-resize focus-visible:outline-2 focus-visible:outline-[var(--app-theme-focus)]"
                type="button"
                aria-label={`Resize ${column.label} column`}
                onpointerdown={(event) => startResize(event, column)}
              ></button>
            {/if}
          </div>
        {/each}
      </div>

      <div
        bind:this={graphViewport}
        use:captureGraphScroll={repositoryId}
        class="relative min-h-0 flex-1 overflow-auto [overflow-anchor:none]"
      >
        <canvas
          bind:this={graphCanvas}
          class="pointer-events-none absolute z-20"
          style={`left: ${graphColumnOffset}px; top: ${graphScrollTop}px; width: ${graphRequiredWidth}px; height: ${graphViewportHeight}px;`}
          aria-hidden="true"
        ></canvas>
        <ol aria-label="Commit history" class="relative" style={`min-width: ${totalGridWidth}px;`}>
          {#if hasChanges}
            <li>
              <button
                data-working-tree
                onkeydown={(event) => navigateHistory(event, null)}
                class={`grid w-full items-center border-b border-[var(--app-theme-border)] text-left transition hover:bg-[var(--app-theme-sidebar-row-hover)] focus-visible:outline-2 focus-visible:outline-[var(--app-theme-focus)] ${
                  changesSelected ? "bg-[var(--app-theme-accent-surface)]" : "bg-[var(--app-theme-surface)]"
                }`}
                style={`grid-template-columns: ${gridTemplate}; height: ${rowHeight}px;`}
                type="button"
                onclick={onSelectChanges}
              >
                <span class="relative z-30 flex min-w-0 items-center gap-0.5 overflow-visible px-0.5">
                  {#if snapshot.status.currentBranch}
                    <span class="max-w-full truncate rounded-[2px] border border-[var(--app-theme-accent)]/30 bg-[var(--app-theme-accent-surface)] px-0.5 py-0 text-[10px] font-semibold leading-3.5 text-[var(--app-theme-accent-surface-foreground)]">
                      {snapshot.status.currentBranch}
                    </span>
                  {/if}
                </span>
                <span class="relative h-full" aria-hidden="true"></span>
                <span class="relative z-30 flex h-full min-w-0 items-center pl-2 pr-1" style="background-color: inherit;">
                  <span class="block truncate text-xs font-semibold text-[var(--app-theme-text)]">
                    Changed files
                    <span class="ml-0.5 text-[10px] font-medium text-[var(--app-theme-text-muted)]">{snapshot.status.changedFiles.length} files</span>
                  </span>
                </span>
              </button>
            </li>
          {/if}

          <li aria-hidden="true" style={`height: ${rowRange.before}px;`}></li>
          {#each visibleRows as row, index (row.commit.hash)}
            {@const commit = row.commit}
            {@const stash = row.stash}
            {@const graphCommit = row.graphCommit}
            {@const commitRefs = refsByTarget.get(commit.hash) ?? []}
            {@const ghostRef = branchRefByLineCommit.get(commit.hash) ?? nearestDescendantRefs.get(commit.hash) ?? branchRefByMergeTargetCommit.get(commit.hash) ?? branchRefByLaneCommit.get(commit.hash) ?? branchRefByFirstParentCommit.get(commit.hash)}
            <li aria-setsize={graphRows.length + Number(hasChanges)} aria-posinset={rowRange.start + index + Number(hasChanges) + 1}>
              <button
                class={`grid w-full items-center border-b border-[var(--app-theme-border)] text-left transition focus-visible:outline-2 focus-visible:outline-[var(--app-theme-focus)] ${
                  contextMenuTarget?.hash === commit.hash
                    ? "bg-[var(--app-theme-sidebar-row-hover)]"
                    : (selectedCommit?.hash === commit.hash || (selectedStash?.hash === commit.hash && selectedStash?.selector === stash?.selector))
                      ? "bg-[var(--app-theme-accent-surface)]"
                      : "bg-[var(--app-theme-surface)] hover:bg-[var(--app-theme-sidebar-row-hover)]"
                }`}
                data-commit-hash={commit.hash}
                aria-pressed={stash ? selectedStash?.hash === stash.hash && selectedStash?.selector === stash.selector : selectedCommit?.hash === commit.hash}
                onkeydown={(event) => handleCommitKeydown(event, commit)}
                style={`grid-template-columns: ${gridTemplate}; height: ${rowHeight}px;`}
                type="button"
                onclick={() => stash ? onSelectStash(stash) : onSelectCommit(commit)}
                oncontextmenu={(event) => handleCommitContextMenu(event, commit)}
                onpointerenter={() => (hoveredRowHash = commit.hash)}
                onpointerleave={() => (hoveredRowHash = hoveredRowHash === commit.hash ? null : hoveredRowHash)}
              >
                <span
                  class={`relative flex min-w-0 items-center gap-0.5 overflow-visible px-0.5 ${
                    hoveredRowHash === commit.hash || contextMenuTarget?.hash === commit.hash || selectedCommit?.hash === commit.hash ? "z-[120]" : "z-[80]"
                  }`}
                >
                    {#if !stash}
                      {#each commitRefs as ref (refKey(ref))}
                        <span
                          data-local-branch={ref.refType === "localBranch" ? ref.name : undefined}
                          class="relative z-30 flex max-w-full items-center gap-0.5 rounded-[2px] border px-0.5 py-0 text-[10px] font-semibold leading-3.5 hover:z-[100] hover:max-w-none hover:whitespace-nowrap"
                          style={refBadgeStyle(ref.refType, graphCommit)}
                        >
                          {#if ref.refType === "remoteBranch"}
                            <Cloud class="h-2.5 w-2.5 shrink-0" size={10} strokeWidth={2.4} />
                          {:else if ref.refType === "localBranch"}
                            <Monitor class="h-2.5 w-2.5 shrink-0" size={10} strokeWidth={2.4} />
                          {/if}
                          <span class="truncate">{displayRefName(ref)}</span>
                        </span>
                      {/each}
                    {/if}
                    {#if !stash && !commitRefs.length && (hoveredRowHash === commit.hash || contextMenuTarget?.hash === commit.hash || selectedCommit?.hash === commit.hash)}
                      {#if ghostRef}
                        <span
                          class="relative z-30 flex max-w-full items-center gap-0.5 rounded-[2px] border border-dashed px-0.5 py-0 text-[10px] font-semibold leading-3.5 opacity-50 hover:z-[100] hover:max-w-none hover:whitespace-nowrap"
                          style={refBadgeStyle(ghostRef.refType, graphCommit)}
                        >
                          {#if ghostRef.refType === "remoteBranch"}
                            <Cloud class="h-2.5 w-2.5 shrink-0" size={10} strokeWidth={2.4} />
                          {:else if ghostRef.refType === "localBranch"}
                            <Monitor class="h-2.5 w-2.5 shrink-0" size={10} strokeWidth={2.4} />
                          {/if}
                          <span class="truncate">{displayRefName(ghostRef)}</span>
                        </span>
                      {/if}
                    {/if}
                </span>
                <span class="relative h-full" aria-hidden="true"></span>
                <span class="relative z-30 flex h-full min-w-0 items-center pl-2 pr-1" style="background-color: inherit;">
                  <span class="block truncate text-xs font-medium text-[var(--app-theme-text)]">
                    {#if stash}
                      {stash.message}
                      {#if stash.branch}
                        <span class="ml-1 text-[10px] font-medium text-[var(--app-theme-text-muted)]">on {stash.branch}</span>
                      {/if}
                    {:else}
                      {commit.message}
                    {/if}
                  </span>
                </span>
              </button>
            </li>
          {/each}
          <li aria-hidden="true" style={`height: ${rowRange.after}px;`}></li>
        </ol>
      </div>
    </div>
  {:else}
    <div class="grid h-full place-items-center p-8 text-center">
      <div>
        <p class="text-sm font-bold uppercase text-[var(--app-theme-text-muted)]">Git Graph</p>
        <h2 class="mt-2 text-2xl font-semibold text-[var(--app-theme-text)]">Open a repository to view history.</h2>
      </div>
    </div>
  {/if}
</section>
