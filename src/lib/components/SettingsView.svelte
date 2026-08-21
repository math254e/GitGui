<script lang="ts">
  import { onDestroy } from "svelte";
  import {
    ExternalLink,
    GitBranch,
    Info,
    Link2,
    Palette,
    Settings,
  } from "@lucide/svelte";
  import {
    applyThemeColorPreview,
    BUILT_IN_THEMES,
    DEFAULT_THEME_ID,
    getCustomThemes,
    getThemeColorsForMode,
    getThemeDefinition,
    installCustomTheme,
    removeCustomTheme,
    themeIdFromName,
    updateCustomTheme,
  } from "$lib/theme/themePalette";
  import { themeStore } from "$lib/theme/useTheme";
  import type {
    ThemeAppearance,
    ThemeColors,
    ThemeDefinition as RuntimeThemeDefinition,
    ThemePreferenceMode,
    ThemeSnapshot,
  } from "$lib/theme/types";
  import ThemeAppearancePanel from "$lib/components/settings/ThemeAppearancePanel.svelte";
  import ThemeDeleteDialog from "$lib/components/settings/ThemeDeleteDialog.svelte";
  import ThemeEditorPanel from "$lib/components/settings/ThemeEditorPanel.svelte";
  import ThemeImportDialog from "$lib/components/settings/ThemeImportDialog.svelte";
  import type {
    ThemeDefinition as PreviewThemeDefinition,
    ThemePalette,
  } from "$lib/components/settings/theme-types";
  import {
    readBranchSwitchMergePreference,
    writeBranchSwitchMergePreference,
  } from "$lib/preferences";

  type SettingsSection = "general" | "appearance" | "connections";
  type BranchSwitchMode = "normal" | "merge";

  let activeSection = $state<SettingsSection>("general");
  let branchSwitchMode = $state<BranchSwitchMode>(readBranchSwitchMergePreference() ? "merge" : "normal");
  let gitExecutable = $state("git");
  let autoFetch = $state(true);
  let themeNotice = $state("");
  let showThemeEditor = $state(false);
  let showThemeImport = $state(false);
  let editingTheme = $state<RuntimeThemeDefinition | null>(null);
  let removeThemeTarget = $state<RuntimeThemeDefinition | null>(null);
  let themeSnapshot = $state<ThemeSnapshot>(themeStore.getSnapshot());
  let customThemes = $state<ReadonlyArray<RuntimeThemeDefinition>>(getCustomThemes());

  const sections: Array<{ id: SettingsSection; label: string }> = [
    { id: "general", label: "General" },
    { id: "appearance", label: "Appearance" },
    { id: "connections", label: "Connections" },
  ];

  const unsubscribeTheme = themeStore.subscribe((snapshot) => {
    themeSnapshot = snapshot;
    customThemes = getCustomThemes();
  });

  onDestroy(unsubscribeTheme);

  const sectionTitle = $derived(
    sections.find((section) => section.id === activeSection)?.label ?? "General",
  );
  const allThemes = $derived([...BUILT_IN_THEMES, ...customThemes]);
  const previewThemes = $derived(allThemes.map(toPreviewTheme));
  const selectedThemeIds = $derived({
    light: themeSnapshot.themeHalves?.light ?? themeSnapshot.theme,
    dark: themeSnapshot.themeHalves?.dark ?? themeSnapshot.theme,
  });

  function toPreviewPalette(colors: ThemeColors): ThemePalette {
    return {
      canvas: colors.canvas,
      sidebar: colors.sidebar,
      sidebarForeground: colors.sidebarForeground,
      sidebarMutedForeground: colors.sidebarMutedForeground,
      sidebarBorder: colors.sidebarBorder,
      sidebarRowHover: colors.sidebarRowHover,
      sidebarRowSelected: colors.sidebarRowSelected,
      surface: colors.surface,
      surfaceRaised: colors.surfaceRaised,
      surfaceOverlay: colors.surfaceOverlay,
      text: colors.text,
      textMuted: colors.textMuted,
      border: colors.border,
      accent: colors.accent,
      accentForeground: colors.accentForeground,
      accentSurface: colors.accentSurface,
      messageSurface: colors.messageSurface,
      messageAction: colors.messageAction,
    };
  }

  function toPreviewTheme(theme: RuntimeThemeDefinition): PreviewThemeDefinition {
    const light = getThemeColorsForMode(theme, "light") ?? theme.colors;
    const dark = getThemeColorsForMode(theme, "dark") ?? theme.colors;

    return {
      id: theme.id,
      label: theme.label,
      colors: {
        light: toPreviewPalette(light),
        dark: toPreviewPalette(dark),
      },
      collection: theme.collection?.id,
      managed: theme.managed,
      removable: customThemes.some((customTheme) => customTheme.id === theme.id),
    };
  }

  function selectSection(section: SettingsSection) {
    activeSection = section;
    themeNotice = "";
  }

  function setBranchSwitchMode(mode: BranchSwitchMode) {
    branchSwitchMode = mode;
    writeBranchSwitchMergePreference(mode === "merge");
  }

  function handleBranchSwitchModeChange(event: Event) {
    const value = (event.currentTarget as HTMLSelectElement).value;
    setBranchSwitchMode(value === "merge" ? "merge" : "normal");
  }

  function setAppearanceMode(mode: ThemePreferenceMode) {
    if (!themeStore.setAppearanceMode(mode)) {
      themeNotice = "The appearance preference could not be saved.";
      return;
    }
    themeNotice = "";
  }

  function selectTheme(themeId: string, appearance: ThemePreferenceMode) {
    const saved = appearance === "system"
      ? themeStore.setTheme(themeId)
      : themeStore.setThemeHalf(appearance as ThemeAppearance, themeId);

    themeNotice = saved ? "" : "The theme selection could not be saved.";
  }

  function duplicateTheme(themeId: string) {
    const source = getThemeDefinition(themeId);
    if (!source) return;

    const existingIds = new Set(allThemes.map((theme) => theme.id));
    let copyId = themeIdFromName(`${source.label}-copy`);
    let suffix = 2;
    while (existingIds.has(copyId)) {
      copyId = themeIdFromName(`${source.label}-copy-${suffix}`);
      suffix += 1;
    }

    try {
      installCustomTheme({
        ...source,
        id: copyId,
        label: `${source.label} Copy`,
        managed: false,
      });
      customThemes = getCustomThemes();
      themeStore.setTheme(copyId);
      themeNotice = `${source.label} copied.`;
    } catch {
      themeNotice = "That theme could not be copied.";
    }
  }

  function requestRemoveTheme(themeId: string) {
    const target = customThemes.find((theme) => theme.id === themeId);
    if (!target) return;
    removeThemeTarget = target;
    themeNotice = "";
  }

  function confirmRemoveTheme() {
    const target = removeThemeTarget;
    if (!target) return;

    try {
      const baseIsActive = themeSnapshot.theme === target.id;
      if (baseIsActive) {
        if (!themeStore.setTheme(DEFAULT_THEME_ID)) {
          throw new Error("The active theme could not be changed.");
        }
      } else {
        for (const appearance of ["light", "dark"] as const) {
          if (themeSnapshot.themeHalves?.[appearance] !== target.id) continue;
          if (!themeStore.setThemeHalf(appearance, null)) {
            throw new Error("The active theme variant could not be changed.");
          }
        }
      }

      removeCustomTheme(target.id);
      customThemes = getCustomThemes();
      themeStore.refreshTheme();
      removeThemeTarget = null;
      themeNotice = `${target.label} removed.`;
    } catch (error) {
      themeNotice = error instanceof Error ? error.message : "That theme could not be removed.";
    }
  }

  function openThemeEditor() {
    editingTheme = null;
    showThemeEditor = true;
    themeNotice = "";
  }

  function openThemeImport() {
    showThemeImport = true;
    themeNotice = "";
  }

  function closeThemeEditor() {
    showThemeEditor = false;
    editingTheme = null;
    themeStore.refreshTheme();
  }

  function saveTheme(theme: RuntimeThemeDefinition) {
    try {
      if (editingTheme) updateCustomTheme(theme);
      else installCustomTheme(theme);
      customThemes = getCustomThemes();
      themeStore.setTheme(theme.id);
      showThemeEditor = false;
      editingTheme = null;
      themeStore.refreshTheme();
      themeNotice = `${theme.label} saved.`;
    } catch (error) {
      themeNotice = error instanceof Error ? error.message : "That theme could not be saved.";
    }
  }

  function importTheme(theme: RuntimeThemeDefinition) {
    try {
      installCustomTheme(theme);
      customThemes = getCustomThemes();
      themeStore.setTheme(theme.id);
      showThemeImport = false;
      themeNotice = `${theme.label} imported.`;
    } catch (error) {
      themeNotice = error instanceof Error ? error.message : "That theme could not be imported.";
    }
  }
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
              onclick={() => selectSection(section.id)}
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
      {#if activeSection === "appearance"}
        <ThemeAppearancePanel
          themes={previewThemes}
          selectedThemeId={themeSnapshot.theme}
          selectedThemeIds={selectedThemeIds}
          appearanceMode={themeSnapshot.appearanceMode}
          selectedThemeAppearance={themeSnapshot.appearanceMode}
          onAppearanceModeChange={setAppearanceMode}
          onThemeSelect={selectTheme}
          onCreateTheme={openThemeEditor}
          onImportTheme={openThemeImport}
          onDuplicateTheme={duplicateTheme}
          onRemoveTheme={requestRemoveTheme}
        />
        {#if themeNotice}
          <p class="mx-auto max-w-[1080px] px-5 pb-6 text-sm text-[var(--app-theme-text-muted)] sm:px-8 lg:px-12" aria-live="polite">
            {themeNotice}
          </p>
        {/if}
      {:else}
        <div class="mx-auto max-w-[920px] px-6 py-8 sm:px-8 lg:px-12 lg:py-12">
          <header class="border-b border-[var(--app-theme-border)] pb-8">
            <p class="text-sm font-medium text-[var(--app-theme-text-subtle)]">Settings / {sectionTitle}</p>
            <div class="mt-3 flex flex-wrap items-end justify-between gap-4">
              <div>
                <h2 class="text-[28px] font-semibold tracking-[-0.03em] text-[var(--app-theme-text)]">{sectionTitle}</h2>
                <p class="mt-2 max-w-[620px] text-sm leading-6 text-[var(--app-theme-text-muted)]">
                  {#if activeSection === "general"}
                    Choose how GitGui handles local changes when switching branches.
                  {:else}
                    Configure how GitGui finds Git and connects to repositories.
                  {/if}
                </p>
              </div>
            </div>
          </header>

          {#if activeSection === "general"}
            <div class="divide-y divide-[var(--app-theme-border-subtle)]">
              <section class="py-7">
                <label class="flex flex-wrap items-center justify-between gap-4 py-3" for="branch-switch-mode">
                  <span>
                    <span class="block text-sm font-medium text-[var(--app-theme-text-secondary)]">Branch switch mode</span>
                    <span class="mt-1 block max-w-[620px] text-xs leading-5 text-[var(--app-theme-text-subtle)]">Normal keeps local changes in place. Merge uses <code class="rounded bg-[var(--app-theme-muted)] px-1 py-0.5 font-mono text-[11px]">git switch --merge</code> and may leave conflicts to resolve.</span>
                  </span>
                  <select
                    id="branch-switch-mode"
                    value={branchSwitchMode}
                    onchange={handleBranchSwitchModeChange}
                    class="h-9 w-full max-w-[190px] rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-input)] px-3 text-sm text-[var(--app-theme-text-secondary)] outline-none transition focus:border-[var(--app-theme-focus)] focus:ring-2 focus:ring-[var(--app-theme-focus-ring)]"
                  >
                    <option value="normal">Normal</option>
                    <option value="merge">Merge</option>
                  </select>
                </label>
              </section>
            </div>
          {:else}
            <div class="divide-y divide-[var(--app-theme-border-subtle)]">
              <section class="py-7" aria-labelledby="connections-git">
                <div class="mb-5">
                  <h3 id="connections-git" class="text-sm font-semibold text-[var(--app-theme-text)]">Git installation</h3>
                  <p class="mt-1 text-sm text-[var(--app-theme-text-subtle)]">GitGui uses the system Git executable for repository operations.</p>
                </div>
                <label class="block max-w-[560px]" for="git-executable">
                  <span class="mb-2 block text-xs font-semibold uppercase tracking-[0.08em] text-[var(--app-theme-text-subtle)]">Executable path</span>
                  <div class="flex gap-2">
                    <input id="git-executable" bind:value={gitExecutable} class="h-9 min-w-0 flex-1 rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-input)] px-3 text-sm text-[var(--app-theme-text-secondary)] outline-none transition focus:border-[var(--app-theme-focus)] focus:ring-2 focus:ring-[var(--app-theme-focus-ring)]" />
                    <button type="button" class="inline-flex h-9 items-center gap-2 rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-raised)] px-3 text-sm font-semibold text-[var(--app-theme-text-muted)] transition hover:bg-[var(--app-theme-control-hover)]">Detect</button>
                  </div>
                </label>
              </section>

              <section class="py-7" aria-labelledby="connections-local">
                <div class="mb-5">
                  <h3 id="connections-local" class="text-sm font-semibold text-[var(--app-theme-text)]">Local workspace</h3>
                  <p class="mt-1 text-sm text-[var(--app-theme-text-subtle)]">The local GitGui server is ready for repository access.</p>
                </div>
                <div class="flex flex-wrap items-center justify-between gap-4 border-y border-[var(--app-theme-border-subtle)] py-4">
                  <div class="flex items-center gap-3">
                    <span class="h-2.5 w-2.5 rounded-full bg-[var(--app-theme-success)] shadow-[0_0_0_4px_var(--app-theme-success-surface)]" aria-hidden="true"></span>
                    <div>
                      <p class="text-sm font-semibold text-[var(--app-theme-text-secondary)]">Connected</p>
                      <p class="mt-1 text-xs text-[var(--app-theme-text-subtle)]">127.0.0.1 · Desktop runtime</p>
                    </div>
                  </div>
                  <button type="button" class="inline-flex h-8 items-center gap-2 rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-raised)] px-3 text-xs font-semibold text-[var(--app-theme-text-muted)] transition hover:bg-[var(--app-theme-control-hover)]"><ExternalLink aria-hidden="true" size={13} />Connection details</button>
                </div>
              </section>

              <section class="py-7" aria-labelledby="connections-refresh">
                <div class="flex flex-wrap items-center justify-between gap-4">
                  <div class="flex items-start gap-3">
                    <GitBranch aria-hidden="true" class="mt-0.5 text-[var(--app-theme-text-muted)]" size={17} />
                    <div>
                      <h3 id="connections-refresh" class="text-sm font-semibold text-[var(--app-theme-text)]">Refresh repositories automatically</h3>
                      <p class="mt-1 text-xs text-[var(--app-theme-text-subtle)]">Check open repositories for new commits every 30 seconds.</p>
                    </div>
                  </div>
                  <button type="button" class={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${autoFetch ? "bg-[var(--app-theme-accent)]" : "bg-[var(--app-theme-muted)]"}`} role="switch" aria-checked={autoFetch} aria-label="Refresh repositories automatically" onclick={() => (autoFetch = !autoFetch)}>
                    <span class={`absolute top-1 h-4 w-4 rounded-full bg-[var(--app-theme-surface-raised)] shadow-sm transition-transform ${autoFetch ? "translate-x-6" : "translate-x-1"}`}></span>
                  </button>
                </div>
              </section>

              <p class="flex items-start gap-2 py-6 text-xs leading-5 text-[var(--app-theme-text-subtle)]"><Info aria-hidden="true" class="mt-0.5 shrink-0" size={14} />Remote provider connections will be available here in a future update.</p>
            </div>
          {/if}
        </div>
      {/if}
    </main>
  </div>
</section>

<ThemeImportDialog
  open={showThemeImport}
  onClose={() => (showThemeImport = false)}
  onImported={importTheme}
/>

<ThemeEditorPanel
  open={showThemeEditor}
  theme={editingTheme}
  onCancel={closeThemeEditor}
  onPreview={applyThemeColorPreview}
  onSave={saveTheme}
/>

<ThemeDeleteDialog
  open={removeThemeTarget !== null}
  theme={removeThemeTarget}
  onCancel={() => (removeThemeTarget = null)}
  onConfirm={confirmRemoveTheme}
/> 
