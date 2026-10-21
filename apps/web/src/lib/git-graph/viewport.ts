import type { CommitGraph, CommitInfo, GraphCommit, GraphEdge } from "../types/repository";

type PositionedEdge = { edge: GraphEdge; from: GraphCommit; to: GraphCommit };

/** Immutable interval index: scrolling visits visible spans, including long merges. */
export class GraphRenderIndex {
  readonly positions: Map<string, GraphCommit>;
  readonly commits: Map<string, CommitInfo>;
  readonly rows: GraphCommit[];
  private readonly edges: PositionedEdge[];
  private readonly maxEnd: number[] = [];

  constructor(graph: CommitGraph, commits: CommitInfo[]) {
    this.positions = new Map(graph.commits.map((commit) => [commit.hash, commit]));
    this.commits = new Map(commits.map((commit) => [commit.hash, commit]));
    this.rows = [...graph.commits].sort((a, b) => a.row - b.row);
    this.edges = graph.edges.flatMap((edge) => {
      const from = this.positions.get(edge.from);
      const to = this.positions.get(edge.to);
      return from && to ? [{ edge, from, to }] : [];
    }).sort((a, b) => a.from.row - b.from.row);
    const build = (start: number, end: number, node: number): number => {
      if (start >= end) return 0;
      if (end - start === 1) return this.maxEnd[node] = this.edges[start].to.row;
      const middle = (start + end) >>> 1;
      return this.maxEnd[node] = Math.max(build(start, middle, node * 2), build(middle, end, node * 2 + 1));
    };
    build(0, this.edges.length, 1);
  }

  visibleEdges(firstRow: number, lastRow: number): PositionedEdge[] {
    const visible: PositionedEdge[] = [];
    const visit = (start: number, end: number, node: number) => {
      if (start >= end || this.maxEnd[node] < firstRow || this.edges[start].from.row > lastRow) return;
      if (end - start === 1) { visible.push(this.edges[start]); return; }
      const middle = (start + end) >>> 1;
      visit(start, middle, node * 2);
      visit(middle, end, node * 2 + 1);
    };
    visit(0, this.edges.length, 1);
    return visible;
  }
}

export function visibleRowRange(count: number, scrollTop: number, height: number, rowHeight: number, workingTree: boolean, overscan = 8) {
  const offset = Number(workingTree) * rowHeight;
  const start = Math.min(count, Math.max(0, Math.floor((scrollTop - offset) / rowHeight) - overscan));
  const end = Math.min(count, Math.max(start, Math.ceil((scrollTop + height - offset) / rowHeight) + overscan));
  return { start, end, before: start * rowHeight, after: (count - end) * rowHeight };
}

export type HistoryAnchor = { hash: string; offset: number };

export function captureHistoryAnchor(rows: readonly { hash: string }[], scrollTop: number, rowHeight: number, workingTree: boolean): HistoryAnchor | null {
  if (scrollTop <= 0) return null;
  const index = Math.floor(scrollTop / rowHeight) - Number(workingTree);
  if (index < 0 || !rows.length) return null;
  const row = rows[Math.min(index, rows.length - 1)];
  return { hash: row.hash, offset: scrollTop - (Math.min(index, rows.length - 1) + Number(workingTree)) * rowHeight };
}

export function restoreHistoryAnchor(anchor: HistoryAnchor, rows: readonly { hash: string }[], rowHeight: number, workingTree: boolean): number | null {
  const index = rows.findIndex((row) => row.hash === anchor.hash);
  return index < 0 ? null : (index + Number(workingTree)) * rowHeight + anchor.offset;
}
