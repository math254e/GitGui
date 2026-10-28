<script lang="ts">
  import { tick, type Snippet } from "svelte";

  let { anchor, active, children, onClose }: {
    anchor: HTMLElement | null;
    active: boolean;
    children: Snippet;
    onClose: () => void;
  } = $props();
  const id = $props.id();
  let card = $state<HTMLDivElement | null>(null);
  let visible = $state(false);
  let inside = $state(false);
  let left = $state(0), top = $state(0);
  let displayedAnchor: HTMLElement | null = null;

  $effect(() => {
    const target = anchor;
    const wanted = active || inside;
    if (!target) { visible = false; inside = false; displayedAnchor = null; return; }
    const changed = displayedAnchor !== target;
    if (changed) { visible = false; displayedAnchor = target; }
    const timer = setTimeout(() => {
      if (wanted && target.isConnected) visible = true;
      else { visible = false; inside = false; onClose(); }
    }, wanted ? changed ? 300 : 0 : 120);
    return () => clearTimeout(timer);
  });

  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  }

  $effect(() => {
    const target = anchor, surface = card;
    if (!visible || !target || !surface) return;
    const position = () => {
      if (!target.isConnected) { onClose(); return; }
      const rect = target.getBoundingClientRect();
      const bounds = surface.getBoundingClientRect();
      left = Math.max(8, rect.right + 8 + bounds.width <= window.innerWidth ? rect.right + 8 : rect.left - bounds.width - 8);
      top = Math.max(8, Math.min(rect.top, window.innerHeight - bounds.height - 8));
    };
    const previous = target.getAttribute("aria-describedby");
    target.setAttribute("aria-describedby", id);
    const resize = new ResizeObserver(position); resize.observe(surface);
    const dismissOnScroll = (event: Event) => { if (!(event.target instanceof Node) || !surface.contains(event.target)) onClose(); };
    const dismissOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("scroll", dismissOnScroll, true);
    window.addEventListener("resize", position);
    window.addEventListener("keydown", dismissOnEscape);
    void tick().then(position);
    return () => {
      resize.disconnect();
      window.removeEventListener("scroll", dismissOnScroll, true);
      window.removeEventListener("resize", position);
      window.removeEventListener("keydown", dismissOnEscape);
      if (previous) target.setAttribute("aria-describedby", previous); else target.removeAttribute("aria-describedby");
    };
  });
</script>

{#if visible && anchor}
  <div use:portal bind:this={card} {id} role="tooltip"
    onpointerenter={() => { inside = true; }} onpointerleave={() => { inside = false; }}
    class="fixed z-[500] max-h-[min(420px,calc(100vh-16px))] w-[340px] max-w-[calc(100vw-16px)] overflow-auto rounded-[3px] border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-overlay)] p-3 text-[var(--app-theme-text)] shadow-xl"
    style:left={`${left}px`} style:top={`${top}px`}>
    {@render children()}
  </div>
{/if}
