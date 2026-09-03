<script lang="ts">
  import type { Snippet } from "svelte";

  export type ResizablePane = {
    id: string;
    minWidth: number;
    maxWidth?: number;
    width?: number;
    flexible?: boolean;
  };

  type Props = {
    panes: ResizablePane[];
    pane0?: Snippet;
    pane1?: Snippet;
    pane2?: Snippet;
    onResize?: (id: string, width: number) => void;
  };

  let { panes, pane0, pane1, pane2, onResize }: Props = $props();
  let container: HTMLDivElement;
  let activeResize:
    | {
        pointerId: number;
        paneId: string;
        startX: number;
        startWidth: number;
        direction: 1 | -1;
      }
    | null = $state(null);

  const snippets = $derived([pane0, pane1, pane2]);
  const gridTemplateColumns = $derived(
    panes
      .flatMap((pane, index) => [
        pane.flexible ? `minmax(${pane.minWidth}px, 1fr)` : `${pane.width ?? pane.minWidth}px`,
        ...(index < panes.length - 1 ? ["0px"] : []),
      ])
      .join(" "),
  );

  function startResize(event: PointerEvent, beforeIndex: number) {
    const before = panes[beforeIndex];
    const after = panes[beforeIndex + 1];
    const pane = before.flexible ? after : before;

    if (!pane || pane.flexible || typeof pane.width !== "number") {
      return;
    }

    event.preventDefault();
    container.setPointerCapture(event.pointerId);
    activeResize = {
      pointerId: event.pointerId,
      paneId: pane.id,
      startX: event.clientX,
      startWidth: pane.width,
      direction: pane === before ? 1 : -1,
    };
  }

  function resize(event: PointerEvent) {
    if (!activeResize) {
      return;
    }

    const pane = panes.find((candidate) => candidate.id === activeResize?.paneId);

    if (!pane) {
      return;
    }

    const delta = (event.clientX - activeResize.startX) * activeResize.direction;
    onResize?.(pane.id, clampPaneWidth(pane, activeResize.startWidth + delta));
  }

  function stopResize(event: PointerEvent) {
    if (!activeResize) {
      return;
    }

    if (container.hasPointerCapture(activeResize.pointerId)) {
      container.releasePointerCapture(activeResize.pointerId);
    }

    activeResize = null;
  }

  function clampPaneWidth(pane: ResizablePane, width: number) {
    const otherMinimumWidths = panes.reduce((total, candidate) => {
      if (candidate.id === pane.id) {
        return total;
      }

      return total + (candidate.flexible ? candidate.minWidth : candidate.width ?? candidate.minWidth);
    }, 0);
    const containerMaxWidth = container.clientWidth - otherMinimumWidths;
    const maxWidth = Math.max(pane.minWidth, Math.min(pane.maxWidth ?? Number.POSITIVE_INFINITY, containerMaxWidth));

    return Math.min(maxWidth, Math.max(pane.minWidth, Math.round(width)));
  }
</script>

<svelte:window onpointermove={resize} onpointerup={stopResize} onpointercancel={stopResize} />

<div
  bind:this={container}
  class:select-none={activeResize}
  class="relative grid h-full min-h-0 overflow-hidden"
  style:grid-template-columns={gridTemplateColumns}
>
  {#each panes as pane, index (pane.id)}
    <div class="resizable-pane h-full min-h-0 min-w-0 overflow-hidden">
      {#if snippets[index]}
        {@render snippets[index]?.()}
      {/if}
    </div>

    {#if index < panes.length - 1}
      <div
        aria-hidden="true"
        class="relative z-10 h-full w-0 cursor-col-resize"
        onpointerdown={(event) => startResize(event, index)}
      >
        <div class="absolute top-0 bottom-0 left-1/2 w-3 -translate-x-1/2"></div>
      </div>
    {/if}
  {/each}
</div>

<style>
  .resizable-pane :global(> *) {
    height: 100%;
    min-height: 0;
  }
</style>
