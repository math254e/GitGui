<script lang="ts">
  import { onDestroy } from "svelte";
  import { Monitor, Server, Folder } from "@lucide/svelte";
  import { displayHostPath } from "$lib/display-host-path";
  import { dismissContextMenu, showContextMenu } from "$lib/contextMenu";
  import { sameRepository, type ScopedRepositoryRef } from "@gitgui/client-runtime/workspace";
  import FileTreeChevron from "./FileTreeChevron.svelte";
  import type { RepositoryLocation, RepositoryLocationEnvironment } from "./repository-locations";

  let { environments, current, sourceTabId, onSwitch, onOpenInNewTab }: {
    environments: readonly RepositoryLocationEnvironment[];
    current: ScopedRepositoryRef;
    sourceTabId: string;
    onSwitch: (target: ScopedRepositoryRef, source: { tabId: string; target: ScopedRepositoryRef }) => void;
    onOpenInNewTab: (target: ScopedRepositoryRef, source: { tabId: string; target: ScopedRepositoryRef }) => void;
  } = $props();
  let expanded = $state<Record<string, boolean>>({});
  let sectionOpen = $state(true);
  const menuOwner = {};
  onDestroy(() => dismissContextMenu(menuOwner));

  function contextMenu(event: MouseEvent | KeyboardEvent, location: RepositoryLocation) {
    event.preventDefault();
    const target = { ...location.target };
    const source = { tabId: sourceTabId, target: { ...current } };
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const position = event instanceof MouseEvent ? { x: event.clientX, y: event.clientY } : { x: rect.left, y: rect.bottom };
    void showContextMenu([{ id: "open", label: "Open in new tab", icon: "copy" }], position, menuOwner).then((result) => {
      if (result === "open" && source.tabId === sourceTabId && sameRepository(source.target, current)) onOpenInNewTab(target, source);
    });
  }

  function keyboardMenu(event: KeyboardEvent, location: RepositoryLocation) {
    if (event.key === "ContextMenu" || event.key === "Apps" || (event.shiftKey && event.key === "F10")) contextMenu(event, location);
  }
</script>

{#if environments.length}
  <section class="flex min-h-0 flex-col border-b border-[var(--app-theme-sidebar-border)] py-2" aria-label="Repository environments">
    <button type="button" aria-expanded={sectionOpen} onclick={() => { sectionOpen = !sectionOpen; }}
      class="group mb-1 inline-flex items-center gap-1 pl-1.5 text-xs font-bold uppercase text-[var(--app-theme-sidebar-muted-foreground)] transition-colors hover:text-[var(--app-theme-accent-surface-foreground)]">
      <FileTreeChevron expanded={sectionOpen} /><span>Environments ({environments.length})</span>
    </button>
    {#if sectionOpen}
    {#each environments as environment (environment.environmentId)}
      {#if environment.locations.length === 1}
        {@const location = environment.locations[0]}
        <button type="button" title={displayHostPath(location.path)} aria-current={location.current ? "true" : undefined}
          aria-label={`${environment.label}, ${displayHostPath(location.path)}${location.missing ? ", missing" : ""}${environment.status !== "connected" ? `, ${environment.status}` : ""}`}
          class={`flex min-h-[26px] w-full min-w-0 items-center gap-2 px-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-[var(--app-theme-focus)] ${location.current ? "bg-[var(--app-theme-sidebar-row-active)] text-[var(--app-theme-accent-surface-foreground)]" : "text-[var(--app-theme-sidebar-foreground)] hover:bg-[var(--app-theme-sidebar-row-hover)]"}`}
          onclick={() => onSwitch(location.target, { tabId: sourceTabId, target: { ...current } })} oncontextmenu={(event) => contextMenu(event, location)} onkeydown={(event) => keyboardMenu(event, location)}>
          {#if environment.local}<Monitor aria-hidden="true" size={14} class="shrink-0 text-[var(--app-theme-sidebar-muted-foreground)]" />{:else}<Server aria-hidden="true" size={14} class="shrink-0 text-[var(--app-theme-sidebar-muted-foreground)]" />{/if}
          <span class="min-w-0 flex-1 truncate">{environment.label}</span>
          {#if location.missing}<span class="shrink-0 text-xs">Missing</span>{:else if environment.status !== "connected"}<span class="shrink-0 text-xs">{environment.status}</span>{/if}
        </button>
      {:else if environment.locations.length > 1}
        <button type="button" aria-expanded={expanded[environment.environmentId] ?? false}
          aria-controls={`repository-locations-${encodeURIComponent(environment.environmentId)}`}
          class="flex min-h-[26px] w-full min-w-0 items-center gap-1 px-2 text-left text-sm text-[var(--app-theme-sidebar-foreground)] hover:bg-[var(--app-theme-sidebar-row-hover)] focus-visible:outline-2 focus-visible:outline-[var(--app-theme-focus)]"
          onclick={() => { expanded = { ...expanded, [environment.environmentId]: !expanded[environment.environmentId] }; }}>
          <FileTreeChevron expanded={expanded[environment.environmentId] ?? false} />
          {#if environment.local}<Monitor aria-hidden="true" size={14} class="shrink-0 text-[var(--app-theme-sidebar-muted-foreground)]" />{:else}<Server aria-hidden="true" size={14} class="shrink-0 text-[var(--app-theme-sidebar-muted-foreground)]" />{/if}
          <span class="min-w-0 flex-1 truncate">{environment.label}</span>
          {#if environment.status !== "connected"}<span class="shrink-0 text-xs">{environment.status}</span>{/if}
        </button>
          <div id={`repository-locations-${encodeURIComponent(environment.environmentId)}`} hidden={!expanded[environment.environmentId]}>
            {#each environment.locations as location (location.target.repositoryId)}
              <button type="button" title={displayHostPath(location.path)} aria-current={location.current ? "true" : undefined}
                aria-label={`${environment.label}, ${displayHostPath(location.path)}${location.missing ? ", missing" : ""}`}
                class={`flex min-h-[26px] w-full min-w-0 items-center gap-2 py-0 pl-6 pr-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-[var(--app-theme-focus)] ${location.current ? "bg-[var(--app-theme-sidebar-row-active)] text-[var(--app-theme-accent-surface-foreground)]" : "text-[var(--app-theme-sidebar-foreground)] hover:bg-[var(--app-theme-sidebar-row-hover)]"}`}
                onclick={() => onSwitch(location.target, { tabId: sourceTabId, target: { ...current } })} oncontextmenu={(event) => contextMenu(event, location)} onkeydown={(event) => keyboardMenu(event, location)}>
                <Folder aria-hidden="true" size={14} class="shrink-0 text-[var(--app-theme-sidebar-muted-foreground)]" /><span class="min-w-0 flex-1 truncate">{displayHostPath(location.path)}</span>{#if location.missing}<span class="shrink-0 text-xs">Missing</span>{/if}
              </button>
            {/each}
          </div>
      {/if}
    {/each}
    {/if}
  </section>
{/if}
