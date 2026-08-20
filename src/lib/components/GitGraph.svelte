<script lang="ts">
  import { Cloud, Monitor } from "@lucide/svelte";
  import { onDestroy, tick } from "svelte";
  import { drawGitGraphCanvas } from "$lib/git-graph/canvas-renderer";
  import { APP_THEME_VARIABLES, GRAPH_THEME_COLOR_ROLES } from "$lib/theme/types";
  import type { CommitInfo, CommitRef, GraphCommit, RepositorySnapshot, StashInfo } from "$lib/types/repository";

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
  type Props = {
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
  }: Props = $props();
  let columns = $state<HistoryColumn[]>([
    { id: "branch", label: "Branch", width: 118, visible: true },
    { id: "graph", label: "Graph", width: 92, visible: true },
    { id: "message", label: "Message", width: 520, visible: true },
  ]);
  let resizeState = $state<ResizeState | null>(null);
  let restoredColumns = false;
  let hoveredRowHash = $state<string | null>(null);
  let graphViewport = $state<HTMLDivElement | null>(null);
  let graphCanvas = $state<HTMLCanvasElement | null>(null);
  let graphScrollTop = $state(0);
  let graphViewportHeight = $state(0);
  let graphDevicePixelRatio = $state(1);
  let graphThemeRevision = $state(0);
  let lastGraphSignature = "";
  let lastGraphRepository = "";
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
    window.removeEventListener("pointermove", resizeColumn);
    resizeState = null;
  });

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

    viewport.addEventListener("scroll", captureScrollTop, { passive: true });
    const scrollObserver = window.setInterval(captureScrollTop, 50);
    restoreScrollTop(initialRepositoryId);

    return {
      update: (nextRepositoryId: string | null) => {
        if (nextRepositoryId !== currentRepositoryId) {
          restoreScrollTop(nextRepositoryId);
        }
      },
      destroy: () => {
        restoreGeneration += 1;
        window.clearInterval(scrollObserver);
        viewport.removeEventListener("scroll", captureScrollTop);
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
  const graphRows = $derived(buildGraphRows(snapshot));
  const graphCommitByHash = $derived(new Map((snapshot?.graph.commits ?? []).map((commit) => [commit.hash, commit])));
  const graphRequiredWidth = $derived(
    Math.max(90, graphPadding * 2 + Math.max(0, (snapshot?.graph.width ?? 1) - 1) * laneGap + dotRadius * 2),
  );
  const graphColumnWidth = $derived(renderedColumnWidth(columns.find((column) => column.id === "graph")));
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
  const refsByTarget = $derived(groupRefsByTarget(snapshot?.refs ?? []));
  const branchRefByFirstParentCommit = $derived(groupBranchRefByFirstParentCommit(snapshot));
  const branchRefByLineCommit = $derived(groupBranchRefByLineCommit(snapshot));
  const branchRefByLaneCommit = $derived(groupBranchRefByLaneCommit(snapshot, graphCommitByHash, refsByTarget));
  const branchRefByMergeTargetCommit = $derived(
    groupBranchRefByMergeTargetCommit(snapshot, branchRefByFirstParentCommit, branchRefByLaneCommit),
  );
  const branchRefByNearestDescendantCommit = $derived(
    groupBranchRefByNearestDescendantCommit(snapshot, graphCommitByHash, refsByTarget),
  );
  const stashHashes = $derived(
    new Set((snapshot?.stashes ?? []).map((stash) => stash.hash)),
  );

  $effect(() => {
    const viewport = graphViewport;
    const currentSnapshot = snapshot;

    if (!viewport || !currentSnapshot) {
      lastGraphSignature = "";
      lastGraphRepository = "";
      return;
    }

    const repositoryRoot = currentSnapshot.info.root;
    const graphSignature = [
      repositoryRoot,
      ...currentSnapshot.graph.commits.map((commit) => commit.hash),
    ].join("\0");
    const repositoryChanged = Boolean(lastGraphRepository && lastGraphRepository !== repositoryRoot);
    lastGraphRepository = repositoryRoot;

    if (!lastGraphSignature || repositoryChanged) {
      lastGraphSignature = graphSignature;
      return;
    }

    if (graphSignature === lastGraphSignature) {
      return;
    }

    const viewportRect = viewport.getBoundingClientRect();
    const graphRowsInDom = [...viewport.querySelectorAll<HTMLElement>("[data-commit-hash]")];
    const anchorRow =
      graphRowsInDom.find((row) => row.getBoundingClientRect().bottom > viewportRect.top) ??
      graphRowsInDom.at(-1);
    const anchorHash = anchorRow?.dataset.commitHash;
    const anchorTop = anchorRow?.getBoundingClientRect().top;
    lastGraphSignature = graphSignature;

    if (!anchorHash || anchorTop === undefined) {
      return;
    }

    void tick().then(() => {
      if (graphViewport !== viewport) {
        return;
      }

      const nextAnchorRow = [...viewport.querySelectorAll<HTMLElement>("[data-commit-hash]")].find(
        (row) => row.dataset.commitHash === anchorHash,
      );

      if (!nextAnchorRow) {
        return;
      }

      setViewportScrollTop(
        viewport,
        viewport.scrollTop + nextAnchorRow.getBoundingClientRect().top - anchorTop,
      );
    });
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

      const targetRow = [...viewport.querySelectorAll<HTMLElement>("[data-commit-hash]")].find(
        (row) => row.dataset.commitHash === targetHash,
      );

      if (!targetRow) {
        return;
      }

      lastHandledScrollCommandId = commandId;

      const viewportRect = viewport.getBoundingClientRect();
      const targetRect = targetRow.getBoundingClientRect();
      const targetTop = targetRect.top - viewportRect.top + viewport.scrollTop;
      const centeredTop = targetTop - (viewport.clientHeight - targetRow.offsetHeight) / 2;

      setViewportScrollTop(viewport, centeredTop);
      onScrollCommandHandled(commandId);
    });
  });

  $effect(() => {
    const canvas = graphCanvas;
    const currentSnapshot = snapshot;
    const viewportHeight = graphViewportHeight;
    const scrollTop = graphScrollTop;
    const width = graphColumnWidth;
    const dpr = graphDevicePixelRatio;
    const selectedHash = selectedCommit?.hash ?? null;
    const hoveredHash = hoveredRowHash;
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
    drawGitGraphCanvas(canvas, {
      graph: currentSnapshot.graph,
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
    });
  });

  function renderedColumnWidth(column: HistoryColumn | undefined) {
    if (!column) {
      return 0;
    }

    return column.id === "graph" ? Math.max(column.width, graphRequiredWidth) : column.width;
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
      stashes.set(stash.hash, stash);
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

  function groupBranchRefByFirstParentCommit(currentSnapshot: RepositorySnapshot | null) {
    const candidates = new Map<string, CommitRef[]>();

    if (!currentSnapshot) {
      return new Map<string, CommitRef>();
    }

    const commitByHash = new Map(currentSnapshot.commits.map((commit) => [commit.hash, commit]));
    const branchRefs = currentSnapshot.refs.filter((ref) => ref.refType !== "tag" && commitByHash.has(ref.target));

    for (const ref of branchRefs) {
      let hash: string | undefined = ref.target;
      const seen = new Set<string>();

      while (hash && !seen.has(hash)) {
        seen.add(hash);
        const refsForCommit = candidates.get(hash) ?? [];
        refsForCommit.push(ref);
        candidates.set(hash, refsForCommit);

        hash = commitByHash.get(hash)?.parents[0];
      }
    }

    const grouped = new Map<string, CommitRef>();

    for (const [hash, refsForCommit] of candidates) {
      const dedupedRefs = dedupeRemoteRefsWhenLocalExists(refsForCommit);
      grouped.set(hash, bestBranchRef(dedupedRefs, currentSnapshot));
    }

    return grouped;
  }

  function bestBranchRef(refs: CommitRef[], currentSnapshot: RepositorySnapshot) {
    const commitByHash = new Map(currentSnapshot.commits.map((commit) => [commit.hash, commit]));
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
    const commitByHash = new Map(currentSnapshot.commits.map((commit) => [commit.hash, commit]));

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
  ) {
    const grouped = new Map<string, CommitRef>();

    if (!currentSnapshot) {
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

    for (const commit of currentSnapshot.commits) {
      const startGraphCommit = graphCommits.get(commit.hash);
      const candidates: Array<{ ref: CommitRef; target: string; distance: number }> = [];
      const seen = new Set<string>([commit.hash]);
      const queue: Array<{ hash: string; distance: number }> = (firstParentChildrenByParent.get(commit.hash) ?? []).map((child) => ({
        hash: child.hash,
        distance: 1,
      }));
      let closestDistance: number | null = null;

      while (queue.length) {
        const item = queue.shift();

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

    for (const mergeCommit of currentSnapshot.commits) {
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

        while (hash && !seen.has(hash)) {
          seen.add(hash);

          if (!firstParentRefs.has(hash)) {
            grouped.set(hash, targetRef);
          }

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
          style={`left: ${graphColumnOffset}px; top: ${graphScrollTop}px; width: ${graphColumnWidth}px; height: ${graphViewportHeight}px;`}
          aria-hidden="true"
        ></canvas>
        <ol class="relative" style={`min-width: ${totalGridWidth}px;`}>
          {#if hasChanges}
            <li>
              <button
                class={`grid w-full items-center border-b border-[var(--app-theme-border)] text-left transition hover:bg-[var(--app-theme-sidebar-row-hover)] focus-visible:outline-2 focus-visible:outline-[var(--app-theme-focus)] ${
                  changesSelected ? "bg-[var(--app-theme-accent-surface)]" : "bg-[var(--app-theme-surface)]"
                }`}
                style={`grid-template-columns: ${gridTemplate}; min-height: ${rowHeight}px;`}
                type="button"
                onclick={onSelectChanges}
              >
                <span class="relative z-30 flex min-w-0 items-center gap-0.5 overflow-visible px-0.5">
                  {#if snapshot.status.currentBranch}
                    <span class="max-w-full truncate rounded-sm border border-[var(--app-theme-accent)]/30 bg-[var(--app-theme-accent-surface)] px-0.5 py-0 text-[10px] font-semibold leading-3.5 text-[var(--app-theme-accent-surface-foreground)]">
                      {snapshot.status.currentBranch}
                    </span>
                  {/if}
                </span>
                <span class="relative h-full" aria-hidden="true"></span>
                <span class="relative z-20 min-w-0 px-1">
                  <span class="block truncate text-xs font-semibold text-[var(--app-theme-text)]">
                    Changed files
                    <span class="ml-0.5 text-[10px] font-medium text-[var(--app-theme-text-muted)]">{snapshot.status.changedFiles.length} files</span>
                  </span>
                </span>
              </button>
            </li>
          {/if}

          {#each graphRows as row (row.commit.hash)}
            {@const commit = row.commit}
            {@const stash = row.stash}
            {@const graphCommit = row.graphCommit}
            {@const commitRefs = refsByTarget.get(commit.hash) ?? []}
            {@const ghostRef = branchRefByLineCommit.get(commit.hash) ?? branchRefByNearestDescendantCommit.get(commit.hash) ?? branchRefByMergeTargetCommit.get(commit.hash) ?? branchRefByLaneCommit.get(commit.hash) ?? branchRefByFirstParentCommit.get(commit.hash)}
            <li>
              <button
                class={`grid w-full items-center border-b border-[var(--app-theme-border)] text-left transition hover:bg-[var(--app-theme-sidebar-row-hover)] focus-visible:outline-2 focus-visible:outline-[var(--app-theme-focus)] ${
                  selectedCommit?.hash === commit.hash ? "bg-[var(--app-theme-accent-surface)]" : "bg-[var(--app-theme-surface)]"
                }`}
                data-commit-hash={commit.hash}
                style={`grid-template-columns: ${gridTemplate}; min-height: ${rowHeight}px;`}
                type="button"
                onclick={() => onSelectCommit(commit)}
                onpointerenter={() => (hoveredRowHash = commit.hash)}
                onpointerleave={() => (hoveredRowHash = hoveredRowHash === commit.hash ? null : hoveredRowHash)}
              >
                <span
                  class={`relative flex min-w-0 flex-wrap items-center gap-0.5 overflow-visible px-0.5 ${
                    hoveredRowHash === commit.hash || selectedCommit?.hash === commit.hash ? "z-[120]" : "z-[80]"
                  }`}
                >
                    {#if !stash}
                      {#each commitRefs as ref (refKey(ref))}
                        <span
                          class="relative z-30 flex max-w-full items-center gap-0.5 rounded-sm border px-0.5 py-0 text-[10px] font-semibold leading-3.5 hover:z-[100] hover:max-w-none hover:whitespace-nowrap"
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
                    {#if !stash && !commitRefs.length && (hoveredRowHash === commit.hash || selectedCommit?.hash === commit.hash)}
                      {#if ghostRef}
                        <span
                          class="relative z-30 flex max-w-full items-center gap-0.5 rounded-sm border border-dashed px-0.5 py-0 text-[10px] font-semibold leading-3.5 opacity-50 hover:z-[100] hover:max-w-none hover:whitespace-nowrap"
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
                <span class="relative z-30 min-w-0 px-1">
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
