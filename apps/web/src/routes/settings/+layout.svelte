<script lang="ts">
  import { page } from "$app/state";
  import { Link2, Palette, Settings } from "@lucide/svelte";
  import { useWorkspaceStore } from "$lib/workspace";
  import { SETTINGS_SECTIONS, type SettingsSection } from "$lib/workspace/routes";

  let { children } = $props();
  const store = useWorkspaceStore();

  const sections: Array<{ id: SettingsSection; label: string }> = [
    { id: "general", label: "General" },
    { id: "appearance", label: "Appearance" },
    { id: "connections", label: "Connections" },
  ];

  const activeSection = $derived<SettingsSection>(
    SETTINGS_SECTIONS.find(
      (section) => page.route.id === `/settings/${section}`,
    ) ?? "general",
  );
</script>

<section class="h-full min-h-0 overflow-auto bg-[var(--app-theme-canvas)] text-[var(--app-theme-text)]">
  <div class="flex min-h-full w-full flex-col lg:flex-row">
    <aside class="w-full shrink-0 border-b border-[var(--app-theme-sidebar-border)] bg-[var(--app-theme-sidebar)] lg:w-[258px] lg:border-r lg:border-b-0">
      <div class="lg:sticky lg:top-0">
        <nav aria-label="Settings categories">
          {#each sections as section (section.id)}
            <button
              type="button"
              class={`flex h-12 w-full items-center gap-3 border-b border-[var(--app-theme-sidebar-border)] px-4 text-left transition-colors ${
                activeSection === section.id
                  ? "bg-[var(--app-theme-sidebar-row-active)] text-[var(--app-theme-sidebar-foreground)]"
                  : "bg-[var(--app-theme-sidebar)] text-[var(--app-theme-sidebar-muted-foreground)] hover:bg-[var(--app-theme-sidebar-row-hover)] hover:text-[var(--app-theme-sidebar-foreground)]"
              }`}
              aria-current={activeSection === section.id ? "page" : undefined}
              onclick={() => void store.navigateTo(`/settings/${section.id}`)}
            >
              {#if section.id === "general"}
                <Settings aria-hidden="true" class="mt-0.5 shrink-0" size={17} />
              {:else if section.id === "appearance"}
                <Palette aria-hidden="true" class="mt-0.5 shrink-0" size={17} />
              {:else}
                <Link2 aria-hidden="true" class="mt-0.5 shrink-0" size={17} />
              {/if}
              <span class="text-sm font-semibold">{section.label}</span>
            </button>
          {/each}
        </nav>
      </div>
    </aside>

    <main class="min-w-0 flex-1">
      {@render children()}
    </main>
  </div>
</section>
