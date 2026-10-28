<script lang="ts">
  import { Eye, EyeOff, Tag } from "@lucide/svelte";
  import { onDestroy, onMount, tick } from "svelte";
  import { dismissContextMenu, showContextMenu } from "$lib/contextMenu";
  import { graphRefKey } from "$lib/types/branch-visibility";
  import { tagName } from "$lib/types/tags";
  import type { CommitRef } from "$lib/types/repository";
  import type { CommitInfo } from "$lib/types/repository";
  import type { GitTagDetails } from "@gitgui/contracts";
  import DetailsHoverCard from "./DetailsHoverCard.svelte";
  import TagHoverDetails from "./TagHoverDetails.svelte";

  let { tags, commitHashes, selectedCommitHash = null, visibleRefKeys, contextKey,
    onSelectRef, onToggleRefs, canDeleteTag = false, onDeleteTag,
    canCheckoutTag = false, canPushTag = false, onCheckoutTag, onPushTag, commitsByHash = new Map<string, CommitInfo>(), loadTagDetails }: {
    tags: CommitRef[];
    commitHashes: ReadonlySet<string>;
    selectedCommitHash?: string | null;
    visibleRefKeys: ReadonlySet<string>;
    contextKey: string | null;
    onSelectRef?: (ref: CommitRef) => void;
    onToggleRefs?: (refs: CommitRef[], visible: boolean) => void;
    canDeleteTag?: boolean;
    onDeleteTag?: (tag: CommitRef) => void;
    canCheckoutTag?: boolean;
    canPushTag?: boolean;
    onCheckoutTag?: (tag: CommitRef) => void;
    onPushTag?: (tag: CommitRef) => void;
    commitsByHash?: ReadonlyMap<string, CommitInfo>;
    loadTagDetails?: (tag: CommitRef) => Promise<GitTagDetails>;
  } = $props();

  const rowHeight = 26;
  const overscan = 6;
  let viewport = $state<HTMLDivElement | null>(null);
  let viewportHeight = $state(260);
  let scrollTop = $state(0);
  let menuTagName = $state<string | null>(null);
  let destroyed = false;
  const menuOwner = {};
  let hover = $state<{ tag: CommitRef; anchor: HTMLElement } | null>(null);
  let hoverActive = $state(false);
  const start = $derived(Math.max(0, Math.floor(scrollTop / rowHeight) - overscan));
  const end = $derived(Math.min(tags.length, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan));
  const visibleTags = $derived(tags.slice(start, end));

  $effect(() => { void contextKey; dismissContextMenu(menuOwner); hover = null; });
  onDestroy(() => { destroyed = true; dismissContextMenu(menuOwner); });

  function openMenu(tag: CommitRef, position: { x: number; y: number }) {
    const captured = { ...tag };
    const key = contextKey;
    menuTagName = tag.name;
    hover = null;
    void showContextMenu([
      { id: "checkout", label: `Checkout ${tagName(tag)}`, icon: "git-branch", disabled: !canCheckoutTag || !commitHashes.has(tag.target) || !tag.objectId || !onCheckoutTag },
      { id: "push", label: "Push tag", icon: "upload", disabled: !canPushTag || !tag.objectId || !onPushTag },
      { id: "delete", label: "Delete tag…", icon: "trash", separatorBefore: true, destructive: true, disabled: !canDeleteTag || !tag.objectId || !onDeleteTag },
    ], position, menuOwner).then((action) => {
      if (menuTagName === captured.name) menuTagName = null;
      if (!destroyed && key === contextKey && action === "delete" && canDeleteTag) onDeleteTag?.(captured);
      if (!destroyed && key === contextKey && action === "checkout" && canCheckoutTag) onCheckoutTag?.(captured);
      if (!destroyed && key === contextKey && action === "push" && canPushTag) onPushTag?.(captured);
    });
  }

  onMount(() => {
    const element = viewport!;
    const resize = new ResizeObserver(() => { viewportHeight = element.clientHeight; });
    viewportHeight = element.clientHeight;
    resize.observe(element);
    return () => resize.disconnect();
  });

  $effect(() => {
    void contextKey;
    if (viewport) viewport.scrollTop = 0;
    scrollTop = 0;
  });

  $effect(() => {
    const maximum = Math.max(0, tags.length * rowHeight - viewportHeight);
    if (viewport && scrollTop > maximum) {
      viewport.scrollTop = maximum;
      scrollTop = maximum;
    }
  });

  async function navigate(event: KeyboardEvent, index: number) {
    if (event.key === "ContextMenu" || event.key === "Apps" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      openMenu(tags[index], { x: rect.left, y: rect.bottom });
      return;
    }
    const page = Math.max(1, Math.floor(viewportHeight / rowHeight));
    const offset = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1
      : event.key === "PageDown" ? page : event.key === "PageUp" ? -page : 0;
    if (!offset && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? tags.length - 1
      : Math.max(0, Math.min(tags.length - 1, index + offset));
    if (!viewport) return;
    const top = next * rowHeight;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (top + rowHeight > viewport.scrollTop + viewportHeight) viewport.scrollTop = top + rowHeight - viewportHeight;
    scrollTop = viewport.scrollTop;
    await tick();
    viewport?.querySelector<HTMLButtonElement>(`[data-tag-index="${next}"]`)?.focus();
  }
</script>

<div bind:this={viewport} class="h-full min-h-0 overflow-auto" role="list" aria-label="Tags"
  onscroll={(event) => { scrollTop = event.currentTarget.scrollTop; hover = null; }}>
  <div class="relative" role="presentation" style:height={`${tags.length * rowHeight}px`}>
    {#each visibleTags as tag, offset (tag.name)}
      {@const name = tagName(tag)}
      {@const visible = visibleRefKeys.has(graphRefKey(tag))}
      {@const navigable = commitHashes.has(tag.target)}
      {@const selected = selectedCommitHash === tag.target}
      <div role="listitem" aria-setsize={tags.length} aria-posinset={start + offset + 1}
        class={`group absolute inset-x-0 flex items-center text-[13px] ${menuTagName === tag.name ? "bg-[var(--app-theme-sidebar-row-hover)]" : selected ? "bg-[var(--app-theme-sidebar-row-selected)]" : "hover:bg-[var(--app-theme-sidebar-row-hover)]"}`}
        style:height={`${rowHeight}px`} style:top={`${(start + offset) * rowHeight}px`}>
        <button type="button"
          class={`flex h-full w-[22px] shrink-0 items-center justify-center text-[var(--app-theme-sidebar-muted-foreground)] hover:text-[var(--app-theme-accent)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--app-theme-focus)] ${visible ? "opacity-0 group-hover:opacity-100" : "opacity-100"}`}
          aria-label={`${visible ? "Hide" : "Show"} tag ${name} ${visible ? "from" : "in"} graph`}
          title={visible ? "Hide from graph" : "Show in graph"}
          aria-pressed={visible}
          onclick={() => onToggleRefs?.([tag], !visible)}>
          {#if visible}<Eye size={14} />{:else}<EyeOff size={14} />{/if}
        </button>
        <button type="button" data-tag-index={start + offset}
          class={`flex h-full min-w-0 flex-1 items-center gap-1.5 pr-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--app-theme-focus)] ${!visible || !navigable ? "text-[var(--app-theme-sidebar-muted-foreground)]" : "text-[var(--app-theme-sidebar-foreground)]"}`}
          aria-label={name} aria-pressed={selected} aria-disabled={!navigable}
          onpointerenter={(event) => { hover = { tag, anchor: event.currentTarget }; hoverActive = true; }}
          onpointerleave={() => { hoverActive = false; }}
          onfocus={(event) => { hover = { tag, anchor: event.currentTarget }; hoverActive = true; }}
          onblur={() => { hoverActive = false; }}
          onkeydown={(event) => navigate(event, start + offset)}
          oncontextmenu={(event) => { event.preventDefault(); openMenu(tag, { x: event.clientX, y: event.clientY }); }}
          onclick={() => { if (navigable) onSelectRef?.(tag); }}>
          <Tag size={14} class="shrink-0" />
          <span class="truncate">{name}</span>
        </button>
      </div>
    {/each}
  </div>
</div>

<DetailsHoverCard anchor={hover?.anchor ?? null} active={hoverActive} onClose={() => { hover = null; }}>
  {#if hover}<TagHoverDetails tag={hover.tag} commit={commitsByHash.get(hover.tag.target)} loadDetails={loadTagDetails} />{/if}
</DetailsHoverCard>
