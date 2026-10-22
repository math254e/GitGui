<script lang="ts">
  import { onDestroy } from "svelte";
  import { toast } from "svelte-sonner";
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

  let themeNotice = $state("");
  let showThemeEditor = $state(false);
  let showThemeImport = $state(false);
  let editingTheme = $state<RuntimeThemeDefinition | null>(null);
  let removeThemeTarget = $state<RuntimeThemeDefinition | null>(null);
  let themeSnapshot = $state<ThemeSnapshot>(themeStore.getSnapshot());
  let customThemes = $state<ReadonlyArray<RuntimeThemeDefinition>>(getCustomThemes());

  const unsubscribeTheme = themeStore.subscribe((snapshot) => {
    themeSnapshot = snapshot;
    customThemes = getCustomThemes();
  });

  onDestroy(() => {
    unsubscribeTheme();
  });

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
    removeThemeTarget = null;

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
      toast.success(`${target.label} removed`);
    } catch (error) {
      toast.error("Could not remove theme", { description: error instanceof Error ? error.message : "That theme could not be removed." });
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
    const updating = editingTheme !== null;
    showThemeEditor = false;
    editingTheme = null;
    try {
      if (updating) updateCustomTheme(theme);
      else installCustomTheme(theme);
      customThemes = getCustomThemes();
      themeStore.setTheme(theme.id);
      themeStore.refreshTheme();
      toast.success(`${theme.label} saved`);
    } catch (error) {
      themeStore.refreshTheme();
      toast.error("Could not save theme", { description: error instanceof Error ? error.message : "That theme could not be saved." });
    }
  }

  function importTheme(theme: RuntimeThemeDefinition) {
    showThemeImport = false;
    try {
      installCustomTheme(theme);
      customThemes = getCustomThemes();
      themeStore.setTheme(theme.id);
      toast.success(`${theme.label} imported`);
    } catch (error) {
      toast.error("Could not import theme", { description: error instanceof Error ? error.message : "That theme could not be imported." });
    }
  }
</script>

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
