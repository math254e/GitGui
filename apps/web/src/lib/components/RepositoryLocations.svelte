<script lang="ts">
  import { onDestroy } from "svelte";
  import { Monitor, Server, Folder } from "@lucide/svelte";
  import { displayHostPath } from "$lib/display-host-path";
  import { dismissContextMenu, showContextMenu } from "$lib/contextMenu";
  import { sameRepository, type ScopedRepositoryRef } from "@gitgui/client-runtime/workspace";
  import FileTreeChevron from "./FileTreeChevron.svelte";
  import { connectionStatusLabel } from "./connection-status";
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
  <section class:pb-2={sectionOpen} class="flex shrink-0 flex-col border-b border-[var(--app-theme-sidebar-border-subtle)]" aria-label="Repository environments">
    <button type="button" aria-expanded={sectionOpen} onclick={() => { sectionOpen = !sectionOpen; }}
      class="sidebar-section-toggle group">
      <FileTreeChevron expanded={sectionOpen} /><span>Locations</span>{" "}<span class="sidebar-section-count">{environments.length}</span>
    </button>
    {#if sectionOpen}
    {#each environments as environment (environment.environmentId)}
      {#if environment.locations.length === 1}
        {@const location = environment.locations[0]}
        <button type="button" title={displayHostPath(location.path)} aria-current={location.current ? "true" : undefined}
          aria-label={`${environment.local ? "Local" : environment.label}, ${displayHostPath(location.path)}${location.missing ? ", missing" : ""}${environment.status !== "connected" ? `, ${environment.status}` : ""}`}
          class={`rounded-sm flex min-h-8 w-full min-w-0 items-center gap-2 px-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-[var(--app-theme-focus)] ${location.current ? "bg-[var(--app-theme-sidebar-row-active)] text-[var(--app-theme-accent-surface-foreground)]" : "text-[var(--app-theme-sidebar-foreground)] hover:bg-[var(--app-theme-sidebar-row-hover)]"}`}
          onclick={() => onSwitch(location.target, { tabId: sourceTabId, target: { ...current } })} oncontextmenu={(event) => contextMenu(event, location)} onkeydown={(event) => keyboardMenu(event, location)}>
          {#if environment.local}<Monitor aria-hidden="true" size={14} class="shrink-0 text-[var(--app-theme-sidebar-muted-foreground)]" />{:else}<Server aria-hidden="true" size={14} class="shrink-0 text-[var(--app-theme-sidebar-muted-foreground)]" />{/if}
          <span class="min-w-0 flex-1 py-1">
            {#if environment.local}
              <span class="block truncate font-mono text-xs">{displayHostPath(location.path)}</span>
            {:else}
              <span class="block truncate text-[13px] font-medium">{environment.label}</span>
              <span class="block truncate font-mono text-[11px] text-[var(--app-theme-sidebar-muted-foreground)]">{displayHostPath(location.path)}</span>
            {/if}
            {#if location.missing || environment.status !== "connected"}
              <span class="flex flex-wrap gap-x-2 text-[11px] leading-4">
                {#if location.missing}<span class="text-[var(--app-theme-error-foreground)]">Missing</span>{/if}
                {#if environment.status !== "connected"}<span class="text-[var(--app-theme-warning-foreground)]">{connectionStatusLabel(environment.status)}</span>{/if}
              </span>
            {/if}
          </span>
        </button>
      {:else if environment.locations.length > 1}
        <button type="button" aria-expanded={expanded[environment.environmentId] ?? false}
          aria-controls={`repository-locations-${encodeURIComponent(environment.environmentId)}`}
          class="rounded-sm flex min-h-8 w-full min-w-0 items-center gap-1 px-2 text-left text-sm text-[var(--app-theme-sidebar-foreground)] hover:bg-[var(--app-theme-sidebar-row-hover)] focus-visible:outline-2 focus-visible:outline-[var(--app-theme-focus)]"
          onclick={() => { expanded = { ...expanded, [environment.environmentId]: !expanded[environment.environmentId] }; }}>
          <FileTreeChevron expanded={expanded[environment.environmentId] ?? false} />
          {#if environment.local}<Monitor aria-hidden="true" size={14} class="shrink-0 text-[var(--app-theme-sidebar-muted-foreground)]" />{:else}<Server aria-hidden="true" size={14} class="shrink-0 text-[var(--app-theme-sidebar-muted-foreground)]" />{/if}
          <span class="min-w-0 flex-1 truncate">{environment.local ? "On this computer" : environment.label}</span>
          {#if environment.status !== "connected"}<span class="shrink-0 text-[11px] text-[var(--app-theme-warning-foreground)]">{connectionStatusLabel(environment.status)}</span>{/if}
        </button>
          <div id={`repository-locations-${encodeURIComponent(environment.environmentId)}`} hidden={!expanded[environment.environmentId]}>
            {#each environment.locations as location (location.target.repositoryId)}
              <button type="button" title={displayHostPath(location.path)} aria-current={location.current ? "true" : undefined}
                aria-label={`${environment.local ? "Local" : environment.label}, ${displayHostPath(location.path)}${location.missing ? ", missing" : ""}`}
                class={`rounded-sm flex min-h-8 w-full min-w-0 items-center gap-2 py-0 pl-6 pr-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-[var(--app-theme-focus)] ${location.current ? "bg-[var(--app-theme-sidebar-row-active)] text-[var(--app-theme-accent-surface-foreground)]" : "text-[var(--app-theme-sidebar-foreground)] hover:bg-[var(--app-theme-sidebar-row-hover)]"}`}
                onclick={() => onSwitch(location.target, { tabId: sourceTabId, target: { ...current } })} oncontextmenu={(event) => contextMenu(event, location)} onkeydown={(event) => keyboardMenu(event, location)}>
                <Folder aria-hidden="true" size={14} class="shrink-0 text-[var(--app-theme-sidebar-muted-foreground)]" /><span class="min-w-0 flex-1 truncate font-mono text-xs">{displayHostPath(location.path)}</span>{#if location.missing}<span class="shrink-0 text-xs text-[var(--app-theme-error-foreground)]">Missing</span>{/if}
              </button>
            {/each}
          </div>
      {/if}
    {/each}
    {/if}
  </section>
{/if}
