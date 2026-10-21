import type { CommitGraph, CommitInfo } from "$lib/types/repository";
import type { GraphRenderIndex } from "./viewport";

export type GitGraphCanvasOptions = {
  graph: CommitGraph;
  commits: CommitInfo[];
  index: GraphRenderIndex;
  headHash: string | null;
  hasWorkingTreeRow: boolean;
  stashHashes: ReadonlySet<string>;
  selectedHash: string | null;
  hoveredHash: string | null;
  scrollTop: number;
  viewportHeight: number;
  width: number;
  devicePixelRatio: number;
  rowHeight: number;
  laneGap: number;
  graphPadding: number;
  dotRadius: number;
  lineWidth: number;
  colors: readonly string[];
  surfaceColor: string;
};

const curveRadius = 8;
const viewportOverscan = 2;

export function drawGitGraphCanvas(canvas: HTMLCanvasElement, options: GitGraphCanvasOptions) {
  const width = Math.max(1, Math.ceil(options.width));
  const height = Math.max(1, Math.ceil(options.viewportHeight));
  const dpr = Math.max(1, options.devicePixelRatio);
  const pixelWidth = Math.ceil(width * dpr);
  const pixelHeight = Math.ceil(height * dpr);

  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const context = canvas.getContext("2d");

  if (!context) {
    return;
  }

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);

  const { positions, commits } = options.index;
  const top = options.scrollTop - options.rowHeight * viewportOverscan;
  const bottom = options.scrollTop + height + options.rowHeight * viewportOverscan;

  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = options.lineWidth;

  const offset = Number(options.hasWorkingTreeRow);
  const firstRow = Math.max(1, Math.floor(top / options.rowHeight) - offset + 1);
  const lastRow = Math.ceil(bottom / options.rowHeight) - offset + 1;
  for (const { edge, from, to } of options.index.visibleEdges(firstRow, lastRow)) {

    const fromY = yForRow(from.row, options);
    const toY = yForRow(to.row, options);

    if (toY < top || fromY > bottom) {
      continue;
    }

    const fromX = xForLane(from.lane, options);
    const toX = xForLane(to.lane, options);
    const fromCanvasY = fromY - options.scrollTop;
    const toCanvasY = toY - options.scrollTop;
    const colorLane = edge.edgeType === "merge" ? to.lane : from.lane;

    context.beginPath();
    context.setLineDash([]);
    context.strokeStyle = branchColor(colorLane, options.colors);
    context.moveTo(fromX, fromCanvasY);

    if (fromX === toX) {
      context.lineTo(toX, toCanvasY);
    } else if (edge.edgeType === "merge") {
      const direction = Math.sign(toX - fromX);
      context.lineTo(toX - direction * curveRadius, fromCanvasY);
      context.quadraticCurveTo(toX, fromCanvasY, toX, fromCanvasY + curveRadius);
      context.lineTo(toX, toCanvasY);
    } else {
      const direction = Math.sign(toX - fromX);
      context.lineTo(fromX, toCanvasY - curveRadius);
      context.quadraticCurveTo(fromX, toCanvasY, fromX + direction * curveRadius, toCanvasY);
      context.lineTo(toX, toCanvasY);
    }

    context.stroke();
  }

  drawWorkingTreeConnection(context, positions, options, top, bottom);

  const firstVisibleRow = Math.max(
    1,
    Math.floor(top / options.rowHeight) - Number(options.hasWorkingTreeRow) + 1,
  );
  const lastVisibleRow = Math.min(
    options.graph.commits.length,
    Math.ceil(bottom / options.rowHeight) - Number(options.hasWorkingTreeRow) + 1,
  );

  for (const position of options.index.rows.slice(Math.max(0, firstVisibleRow - 1), lastVisibleRow)) {
    if (position.row < firstVisibleRow || position.row > lastVisibleRow) {
      continue;
    }

    const commit = commits.get(position.hash);
    const x = xForLane(position.lane, options);
    const y = yForRow(position.row, options) - options.scrollTop;
    const color = branchColor(position.lane, options.colors);
    const emphasized = position.hash === options.selectedHash || position.hash === options.hoveredHash;
    const radius = options.dotRadius + (emphasized ? 1 : 0);

    context.beginPath();
    context.setLineDash(options.stashHashes.has(position.hash) ? [3, 3] : []);
    context.fillStyle = options.surfaceColor;
    context.strokeStyle = color;
    context.lineWidth = emphasized ? options.lineWidth + 0.75 : options.lineWidth;

    if (options.stashHashes.has(position.hash)) {
      context.rect(x - radius, y - radius, radius * 2, radius * 2);
    } else {
      context.arc(x, y, radius, 0, Math.PI * 2);
    }

    context.fill();
    context.stroke();

    if ((commit?.parents.length ?? 0) > 1) {
      context.beginPath();
      context.setLineDash([]);
      context.fillStyle = color;
      context.arc(x, y, Math.max(2, radius * 0.32), 0, Math.PI * 2);
      context.fill();
    }
  }

  drawWorkingTreeNode(context, options);
}

function drawWorkingTreeConnection(
  context: CanvasRenderingContext2D,
  positions: Map<string, CommitGraph["commits"][number]>,
  options: GitGraphCanvasOptions,
  top: number,
  bottom: number,
) {
  if (!options.hasWorkingTreeRow || options.graph.headLane === null || !options.headHash) {
    return;
  }

  const head = positions.get(options.headHash);

  if (!head) {
    return;
  }

  const startY = options.rowHeight / 2;
  const endY = yForRow(head.row, options);

  if (endY < top || startY > bottom) {
    return;
  }

  const x = xForLane(options.graph.headLane, options);

  context.beginPath();
  context.setLineDash([4, 4]);
  context.lineWidth = options.lineWidth;
  context.strokeStyle = branchColor(options.graph.headLane, options.colors);
  context.moveTo(x, startY - options.scrollTop);
  context.lineTo(x, endY - options.scrollTop);
  context.stroke();
}

function drawWorkingTreeNode(context: CanvasRenderingContext2D, options: GitGraphCanvasOptions) {
  if (!options.hasWorkingTreeRow || options.graph.headLane === null) {
    return;
  }

  const y = options.rowHeight / 2 - options.scrollTop;

  if (y < -options.rowHeight || y > options.viewportHeight + options.rowHeight) {
    return;
  }

  const size = 12;
  const x = xForLane(options.graph.headLane, options);

  context.beginPath();
  context.setLineDash([3, 3]);
  context.lineWidth = options.lineWidth;
  context.fillStyle = options.surfaceColor;
  context.strokeStyle = branchColor(options.graph.headLane, options.colors);
  context.rect(x - size / 2, y - size / 2, size, size);
  context.fill();
  context.stroke();
}

function xForLane(lane: number, options: GitGraphCanvasOptions) {
  return options.graphPadding + lane * options.laneGap;
}

function yForRow(row: number, options: GitGraphCanvasOptions) {
  const displayRow = row - 1 + Number(options.hasWorkingTreeRow);
  return displayRow * options.rowHeight + options.rowHeight / 2;
}

function branchColor(lane: number, colors: readonly string[]) {
  return colors[lane % colors.length] ?? "#64748b";
}
