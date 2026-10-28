<script lang="ts" generics="Item">
  import type { Snippet } from "svelte";
  import { isContextMenuOpen } from "$lib/contextMenu";
  import DetailsHoverCard from "./DetailsHoverCard.svelte";

  let { host, contextKey, getItem, children, excludeDecoration = false }: {
    host: HTMLElement | null;
    contextKey: string | null;
    getItem: (path: string) => Item | undefined;
    children: Snippet<[Item]>;
    excludeDecoration?: boolean;
  } = $props();

  let anchor = $state.raw<HTMLElement | null>(null);
  let active = $state(false);
  let path = $state("");
  const item = $derived(anchor ? getItem(path) : undefined);

  function dismiss() { anchor = null; active = false; }
  $effect(() => { void contextKey; dismiss(); });

  $effect(() => {
    const root = host?.shadowRoot;
    if (!root) return;
    function enter(event: Event) {
      if (isContextMenuOpen()) return;
      const route = event.composedPath();
      if (excludeDecoration && route.some((node) => node instanceof Element && node.getAttribute("data-item-section") === "decoration")) return;
      const row = route.find((node): node is HTMLElement => node instanceof HTMLElement && node.dataset.type === "item" && node.dataset.itemType === "file");
      if (!row) { active = false; return; }
      path = row.dataset.itemPath ?? "";
      anchor = row;
      active = true;
    }
    function leave(event: Event) {
      const next = (event as MouseEvent | FocusEvent).relatedTarget;
      if (next instanceof Node && anchor?.contains(next)) return;
      active = false;
    }
    root.addEventListener("pointerover", enter);
    root.addEventListener("pointerout", leave);
    root.addEventListener("focusin", enter);
    root.addEventListener("focusout", leave);
    root.addEventListener("contextmenu", dismiss);
    root.addEventListener("scroll", dismiss, true);
    // Virtualized trees can recycle a row for another item without a pointer event.
    const observer = new MutationObserver(() => {
      if (anchor && (!anchor.isConnected || anchor.dataset.itemPath !== path)) dismiss();
    });
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-item-path"] });
    return () => {
      observer.disconnect();
      root.removeEventListener("pointerover", enter);
      root.removeEventListener("pointerout", leave);
      root.removeEventListener("focusin", enter);
      root.removeEventListener("focusout", leave);
      root.removeEventListener("contextmenu", dismiss);
      root.removeEventListener("scroll", dismiss, true);
      dismiss();
    };
  });
</script>

<DetailsHoverCard anchor={item ? anchor : null} {active} onClose={dismiss}>
  {#if item}{@render children(item)}{/if}
</DetailsHoverCard>
