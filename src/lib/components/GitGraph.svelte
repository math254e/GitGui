<script lang="ts">
  import { Cloud, Monitor } from "@lucide/svelte";
  import type { CommitInfo, CommitRef, GraphCommit, GraphEdge, RepositorySnapshot } from "$lib/types/repository";

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
  type Props = {
    snapshot: RepositorySnapshot | null;
    selectedCommit: CommitInfo | null;
    changesSelected: boolean;
    onSelectChanges: () => void;
    onSelectCommit: (commit: CommitInfo) => void;
  };

  const rowHeight = 36;
  const headerHeight = 30;
  const laneGap = 24;
  const graphPadding = 18;
  const nodeRadius = 6;
  const workingTreeSize = 14;
  const columnStorageKey = "gitgui.historyColumns.v1";
  const minimumColumnWidth = 24;
  const branchColors = [
    "#008f7a",
    "#006ee6",
    "#d97706",
    "#7c3aed",
    "#dc2626",
    "#0891b2",
    "#16a34a",
    "#be185d",
  ];

  let { snapshot, selectedCommit, changesSelected, onSelectChanges, onSelectCommit }: Props = $props();
  let columns = $state<HistoryColumn[]>([
    { id: "branch", label: "Branch", width: 190, visible: true },
    { id: "graph", label: "Graph", width: 96, visible: true },
    { id: "message", label: "Message", width: 520, visible: true },
  ]);
  let resizeState = $state<ResizeState | null>(null);
  let restoredColumns = false;
  let hoveredRowHash = $state<string | null>(null);

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

  const hasChanges = $derived(Boolean(snapshot?.status.changedFiles.length));
  const visibleColumns = $derived(columns.filter((column) => column.visible));
  const graphRequiredWidth = $derived(Math.max(72, ((snapshot?.graph.width ?? 1) - 1) * laneGap + graphPadding * 2));
  const graphColumnWidth = $derived(columnWidth("graph"));
  const gridTemplate = $derived(
    visibleColumns
      .map((column) => `${column.width}px`)
      .join(" "),
  );
  const totalGridWidth = $derived(
    visibleColumns.reduce((total, column) => total + column.width, 0),
  );
  const visibleRowCount = $derived((snapshot?.commits.length ?? 0) + (hasChanges ? 1 : 0));
  const graphHeight = $derived(Math.max(rowHeight, visibleRowCount * rowHeight));
  const graphCommitByHash = $derived(new Map(snapshot?.graph.commits.map((commit) => [commit.hash, commit]) ?? []));
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
  const currentHeadLane = $derived(snapshot?.graph.headLane ?? 0);

  function columnWidth(columnId: ColumnId) {
    return columns.find((column) => column.id === columnId)?.width ?? 0;
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
      grouped.set(hash, bestBranchRef(dedupedRefs));
    }

    return grouped;
  }

  function bestBranchRef(refs: CommitRef[]) {
    if (!snapshot) {
      return refs[0];
    }

    const commitByHash = new Map(snapshot.commits.map((commit) => [commit.hash, commit]));
    const currentBranch = snapshot.status.currentBranch;
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
        const branchRef = bestBranchRef(directBranchRefs);

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
    return branchColors[lane % branchColors.length];
  }

  function refBadgeStyle(refType: CommitRef["refType"], graphCommit: GraphCommit | undefined) {
    const color = branchColor(graphCommit?.lane ?? 0);
    const tint = refType === "tag" ? 14 : 9;

    return `border-color: ${color}66; color: ${color}; background: color-mix(in srgb, ${color} ${tint}%, white);`;
  }

  function visibleRow(graphCommit: GraphCommit) {
    return graphCommit.row - 1 + (hasChanges ? 1 : 0);
  }

  function xForLane(lane: number) {
    return graphPadding + lane * laneGap;
  }

  function yForGraphCommit(graphCommit: GraphCommit) {
    return visibleRow(graphCommit) * rowHeight + rowHeight / 2;
  }

  function edgePath(edge: GraphEdge) {
    const from = graphCommitByHash.get(edge.from);
    const to = graphCommitByHash.get(edge.to);

    if (!from || !to) {
      return "";
    }

    const x0 = xForLane(from.lane);
    const y0 = yForGraphCommit(from);
    const x1 = xForLane(to.lane);
    const y1 = yForGraphCommit(to);

    if (x0 === x1) {
      return `M ${x0} ${y0} L ${x1} ${y1}`;
    }

    if (edge.edgeType === "merge") {
      const turnY = y0 + Math.min(18, Math.max(8, (y1 - y0) / 3));
      return `M ${x0} ${y0} L ${x0} ${turnY} Q ${x0} ${turnY + 8} ${xForLane(to.lane)} ${turnY + 8} L ${x1} ${y1}`;
    }

    const turnY = y1 - Math.min(18, Math.max(8, (y1 - y0) / 3));
    return `M ${x0} ${y0} L ${x0} ${turnY} Q ${x0} ${y1} ${x1} ${y1}`;
  }

  function edgeColor(edge: GraphEdge) {
    const from = graphCommitByHash.get(edge.from);
    const to = graphCommitByHash.get(edge.to);
    const lane = edge.edgeType === "merge" ? to?.lane : from?.lane;

    return branchColor(lane ?? 0);
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

</script>

<section class="min-h-0 bg-white">
  {#if snapshot}
    <div class="flex h-full min-h-0 flex-col">
      <div
        class="grid border-b border-[#e5e9ee] bg-[#f8fafb] text-[11px] font-bold uppercase text-[#7b8490]"
        style={`grid-template-columns: ${gridTemplate}; min-width: ${totalGridWidth}px; height: ${headerHeight}px;`}
      >
        {#each visibleColumns as column, index}
          <div class="relative flex items-center border-r border-[#e5e9ee] px-3 last:border-r-0">
            <span class="truncate">{column.label}</span>
            {#if index < visibleColumns.length - 1}
              <button
                class="absolute top-0 right-[-4px] z-30 h-full w-2 cursor-col-resize"
                type="button"
                aria-label={`Resize ${column.label} column`}
                onpointerdown={(event) => startResize(event, column)}
              ></button>
            {/if}
          </div>
        {/each}
      </div>

      <div class="relative min-h-0 flex-1 overflow-auto">
        <div
          class="pointer-events-none absolute top-0 z-10 overflow-hidden"
          style={`left: ${columnWidth("branch")}px; width: ${graphColumnWidth}px; height: ${graphHeight}px;`}
          aria-hidden="true"
        >
          <svg
            width={graphRequiredWidth}
            height={graphHeight}
            viewBox={`0 0 ${graphRequiredWidth} ${graphHeight}`}
          >
            {#each snapshot.graph.edges as edge}
              {@const path = edgePath(edge)}
              {#if path}
                <path
                  d={path}
                  fill="none"
                  stroke={edgeColor(edge)}
                  stroke-width="2.75"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  opacity={edge.edgeType === "merge" ? "0.9" : "1"}
                />
              {/if}
            {/each}

            {#if hasChanges}
              <path
                d={`M ${xForLane(currentHeadLane)} ${rowHeight / 2 + workingTreeSize / 2} L ${xForLane(currentHeadLane)} ${rowHeight + rowHeight / 2}`}
                fill="none"
                stroke={branchColor(currentHeadLane)}
                stroke-width="2.75"
                stroke-dasharray="4 4"
                stroke-linecap="round"
                opacity="0.95"
              />
            {/if}
          </svg>
        </div>

        <ol class="relative" style={`min-width: ${totalGridWidth}px;`}>
          {#if hasChanges}
            <li>
              <button
                class={`grid w-full items-center border-b border-[#f0f2f4] text-left transition hover:bg-[#f8fafb] ${
                  changesSelected ? "bg-[#e9f8f5]" : "bg-white/90"
                }`}
                style={`grid-template-columns: ${gridTemplate}; min-height: ${rowHeight}px;`}
                type="button"
                onclick={onSelectChanges}
              >
                <span class="relative z-30 flex min-w-0 items-center gap-1.5 overflow-visible px-3">
                  {#if snapshot.status.currentBranch}
                    <span class="max-w-full truncate rounded border border-[#008f7a]/30 bg-[#e9f8f5] px-2 py-0.5 text-xs font-semibold text-[#006f60]">
                      {snapshot.status.currentBranch}
                    </span>
                  {/if}
                </span>
                <span class="relative z-20 flex h-full items-center overflow-hidden">
                  <span
                    class="absolute rounded border-2 bg-[#e9f8f5]"
                    style={`left: ${xForLane(currentHeadLane) - workingTreeSize / 2}px; top: calc(50% - ${workingTreeSize / 2}px); width: ${workingTreeSize}px; height: ${workingTreeSize}px; border-color: ${branchColor(currentHeadLane)};`}
                  ></span>
                </span>
                <span class="relative z-20 min-w-0 px-3">
                  <span class="block truncate text-sm font-semibold text-[#202124]">
                    Changed files
                    <span class="ml-2 text-xs font-medium text-[#6d7784]">{snapshot.status.changedFiles.length} files</span>
                  </span>
                </span>
              </button>
            </li>
          {/if}

          {#each snapshot.commits as commit}
            {@const graphCommit = graphCommitByHash.get(commit.hash)}
            {@const commitRefs = refsByTarget.get(commit.hash) ?? []}
            {@const ghostRef = branchRefByLineCommit.get(commit.hash) ?? branchRefByNearestDescendantCommit.get(commit.hash) ?? branchRefByMergeTargetCommit.get(commit.hash) ?? branchRefByLaneCommit.get(commit.hash) ?? branchRefByFirstParentCommit.get(commit.hash)}
            <li>
              <button
                class={`grid w-full items-center border-b border-[#f0f2f4] text-left transition hover:bg-[#f8fafb] ${
                  selectedCommit?.hash === commit.hash ? "bg-[#e9f8f5]" : "bg-white/90"
                }`}
                style={`grid-template-columns: ${gridTemplate}; min-height: ${rowHeight}px;`}
                type="button"
                onclick={() => onSelectCommit(commit)}
                onpointerenter={() => (hoveredRowHash = commit.hash)}
                onpointerleave={() => (hoveredRowHash = hoveredRowHash === commit.hash ? null : hoveredRowHash)}
              >
                <span
                  class={`relative flex min-w-0 flex-wrap items-center gap-1.5 overflow-visible px-3 ${
                    hoveredRowHash === commit.hash || selectedCommit?.hash === commit.hash ? "z-[120]" : "z-[80]"
                  }`}
                >
                    {#each commitRefs as ref}
                      <span
                        class="relative z-30 flex max-w-full items-center gap-1 rounded border px-2 py-0.5 text-xs font-semibold hover:z-[100] hover:max-w-none hover:whitespace-nowrap"
                        style={refBadgeStyle(ref.refType, graphCommit)}
                      >
                        {#if ref.refType === "remoteBranch"}
                          <Cloud class="h-3 w-3 shrink-0" size={12} strokeWidth={2.4} />
                        {:else if ref.refType === "localBranch"}
                          <Monitor class="h-3 w-3 shrink-0" size={12} strokeWidth={2.4} />
                        {/if}
                        <span class="truncate">{displayRefName(ref)}</span>
                      </span>
                    {/each}
                    {#if !commitRefs.length && (hoveredRowHash === commit.hash || selectedCommit?.hash === commit.hash)}
                      {#if ghostRef}
                        <span
                          class="relative z-30 flex max-w-full items-center gap-1 rounded border border-dashed px-2 py-0.5 text-xs font-semibold opacity-50 hover:z-[100] hover:max-w-none hover:whitespace-nowrap"
                          style={refBadgeStyle(ghostRef.refType, graphCommit)}
                        >
                          {#if ghostRef.refType === "remoteBranch"}
                            <Cloud class="h-3 w-3 shrink-0" size={12} strokeWidth={2.4} />
                          {:else if ghostRef.refType === "localBranch"}
                            <Monitor class="h-3 w-3 shrink-0" size={12} strokeWidth={2.4} />
                          {/if}
                          <span class="truncate">{displayRefName(ghostRef)}</span>
                        </span>
                      {/if}
                    {/if}
                </span>
                <span class="relative z-20 flex h-full items-center overflow-hidden">
                  {#if graphCommit}
                    <span
                      class="absolute rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(32,33,36,0.08)]"
                      style={`left: ${xForLane(graphCommit.lane) - nodeRadius}px; top: calc(50% - ${nodeRadius}px); width: ${nodeRadius * 2}px; height: ${nodeRadius * 2}px; background: ${branchColor(graphCommit.lane)};`}
                    ></span>
                  {/if}
                </span>
                <span class="relative z-20 min-w-0 px-3">
                  <span class="block truncate text-sm font-medium text-[#202124]">{commit.message}</span>
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
        <p class="text-sm font-bold uppercase text-[#7b8490]">Git Graph</p>
        <h2 class="mt-2 text-2xl font-semibold text-[#202124]">Open a repository to view history.</h2>
      </div>
    </div>
  {/if}
</section>
