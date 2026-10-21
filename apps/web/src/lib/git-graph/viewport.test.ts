import { describe, expect, it } from "vitest";
import { GraphRenderIndex, visibleRowRange, captureHistoryAnchor, restoreHistoryAnchor } from "./viewport";
import type { CommitGraph } from "../types/repository";

describe("large history viewport", () => {
  it("bounds row rendering and keeps the full scroll extent", () => {
    const range = visibleRowRange(100_000, 1_700_005, 680, 34, true);
    expect(range.end - range.start).toBeLessThanOrEqual(37);
    expect(range.before + (range.end - range.start) * 34 + range.after).toBe(3_400_000);
    expect(visibleRowRange(0, 0, 680, 34, false)).toEqual({ start: 0, end: 0, before: 0, after: 0 });
  });

  it("finds spans crossing the viewport when neither endpoint is visible", () => {
    const graph: CommitGraph = {
      commits: Array.from({ length: 100_000 }, (_, i) => ({ hash: String(i), row: i + 1, lane: i === 0 ? 1 : 0 })),
      edges: Array.from({ length: 99_999 }, (_, i) => ({ from: String(i), to: String(i + 1), edgeType: "normal" as const })),
      width: 2, headLane: 0,
    };
    graph.edges.push({ from: "0", to: "99999", edgeType: "merge" });
    const index = new GraphRenderIndex(graph, []);
    const visible = index.visibleEdges(50_000, 50_020);
    expect(visible).toHaveLength(23);
    expect(visible.some(({ edge }) => edge.edgeType === "merge")).toBe(true);
    expect(index.visibleEdges(100_002, 100_020)).toEqual([]);
    expect(new GraphRenderIndex({ commits: [], edges: [], width: 1, headLane: null }, []).visibleEdges(1, 10)).toEqual([]);
  });

  it("preserves the viewed commit and pixel offset across new tips and dirty-row transitions", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ hash: String(i) }));
    const anchor = captureHistoryAnchor(rows, 34 * 60 + 9, 34, false)!;
    const next = [{ hash: "new" }, ...rows];
    expect(restoreHistoryAnchor(anchor, next, 34, true)).toBe(34 * 62 + 9);
    expect(restoreHistoryAnchor(anchor, next.filter((row) => row.hash !== anchor.hash), 34, true)).toBeNull();
    expect(captureHistoryAnchor(rows, 0, 34, false)).toBeNull();
  });
});
