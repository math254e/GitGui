<script lang="ts">
  import { Check, Plus, Upload } from "@lucide/svelte";
  import ThemeCard from "./ThemeCard.svelte";
  import ThemeWireframe from "./ThemeWireframe.svelte";
  import {
    DEFAULT_THEME_DEFINITIONS,
    type AppearanceModeChangeHandler,
    type ThemeAppearance,
    type ThemeAppearanceMode,
    type ThemeDefinition,
    type ThemeSelectionHandler,
  } from "./theme-types";

  type Props = {
    themes?: readonly ThemeDefinition[];
    selectedThemeId?: string;
    selectedThemeIds?: Partial<Record<ThemeAppearance, string>>;
    appearanceMode?: ThemeAppearanceMode;
    selectedThemeAppearance?: ThemeAppearanceMode;
    heading?: string;
    description?: string;
    onAppearanceModeChange?: AppearanceModeChangeHandler;
    onThemeSelect?: ThemeSelectionHandler;
    onCreateTheme?: () => void;
    onImportTheme?: () => void;
    onDuplicateTheme?: (themeId: string) => void;
    onRemoveTheme?: (themeId: string) => void;
    class?: string;
  };

  let {
    themes = DEFAULT_THEME_DEFINITIONS,
    selectedThemeId = "t3-code",
    selectedThemeIds,
    appearanceMode = "system",
    selectedThemeAppearance,
    heading = "Appearance",
    description = "Choose how GitGui looks. Use a built-in theme or make your own.",
    onAppearanceModeChange,
    onThemeSelect,
    onCreateTheme,
    onImportTheme,
    onDuplicateTheme,
    onRemoveTheme,
    class: className = "",
  }: Props = $props();

  const schemeOptions: Array<{ id: ThemeAppearanceMode; label: string; description: string }> = [
    { id: "system", label: "System", description: "Follow your operating system" },
    { id: "light", label: "Light", description: "Always use light mode" },
    { id: "dark", label: "Dark", description: "Always use dark mode" },
  ];

  const availableThemes = $derived(themes.length > 0 ? themes : DEFAULT_THEME_DEFINITIONS);
  const activeThemeAppearance = $derived(selectedThemeAppearance ?? appearanceMode);
  const activeThemeIds = $derived(
    selectedThemeIds ?? { light: selectedThemeId, dark: selectedThemeId },
  );
  // Scheme previews must reflect independent light/dark selections, too.
  const lightPreview = $derived(
    (availableThemes.find((theme) => theme.id === activeThemeIds.light) ?? availableThemes[0]).colors.light,
  );
  const darkPreview = $derived(
    (availableThemes.find((theme) => theme.id === activeThemeIds.dark) ?? availableThemes[0]).colors.dark,
  );

  function selectAppearance(mode: ThemeAppearanceMode) {
    onAppearanceModeChange?.(mode);
  }
</script>

<section
  class={`min-h-full w-full px-5 py-6 text-[var(--app-theme-text,#f4f4f5)] sm:px-8 sm:py-8 lg:px-12 lg:py-8 ${className}`}
  style="background: var(--app-theme-canvas, #0a0a0b)"
>
  <div class="mx-auto max-w-[1080px]">
    <header class="max-w-[760px]">
      <h1 class="text-xl font-semibold tracking-tight">{heading}</h1>
      <p class="mt-2 text-sm leading-6 text-[var(--app-theme-text-muted,#92939b)]">{description}</p>
    </header>

    <section class="mt-6" aria-labelledby="theme-color-scheme-heading">
      <h2 id="theme-color-scheme-heading" class="text-base font-semibold">Color scheme</h2>

      <div class="mt-4 grid gap-3 grid-cols-3">
        {#each schemeOptions as option (option.id)}
          {@const isSelected = appearanceMode === option.id}
          <button
            type="button"
            class="appearance-option group min-w-0 rounded-md border p-2 text-left transition-colors duration-150"
            data-selected={isSelected}
            aria-pressed={isSelected}
            aria-label={`${option.label}: ${option.description}`}
            onclick={() => selectAppearance(option.id)}
          >
            <div class="h-[86px] sm:h-[112px]">
              <ThemeWireframe
                mode={option.id}
                lightPalette={lightPreview}
                darkPalette={darkPreview}
              />
            </div>
            <div class="flex items-center justify-between gap-2 px-1 pb-1 pt-2.5">
              <span class={`text-sm font-medium ${isSelected ? "text-[var(--app-theme-text)]" : "text-[var(--app-theme-text-muted)]"}`}>
                {option.label}
              </span>
              <span class="flex h-4 w-4 items-center justify-center text-[var(--app-theme-text)]">
                {#if isSelected}<Check aria-hidden="true" size={14} />{/if}
              </span>
            </div>
          </button>
        {/each}
      </div>
    </section>

    <section class="mt-6" aria-labelledby="themes-heading">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 id="themes-heading" class="text-base font-semibold">Themes</h2>

        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="inline-flex h-8 items-center gap-1.5 rounded-sm border border-[var(--app-theme-border-subtle)] px-2.5 text-sm font-medium text-[var(--app-theme-text)] transition-colors hover:bg-[var(--app-theme-control-hover)]"
            onclick={() => onCreateTheme?.()}
          >
            <Plus aria-hidden="true" size={15} />
            Create theme
          </button>
          <button
            type="button"
            class="inline-flex h-8 items-center gap-1.5 rounded-sm border border-[var(--app-theme-border-subtle)] px-2.5 text-sm font-medium text-[var(--app-theme-text)] transition-colors hover:bg-[var(--app-theme-control-hover)]"
            onclick={() => onImportTheme?.()}
          >
            <Upload aria-hidden="true" size={15} />
            Import theme
          </button>
        </div>
      </div>

      <div class="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {#each availableThemes as theme (theme.id)}
          {@const lightSelected = (appearanceMode === "system" || appearanceMode === "light") && activeThemeIds.light === theme.id}
          {@const darkSelected = (appearanceMode === "system" || appearanceMode === "dark") && activeThemeIds.dark === theme.id}
          <ThemeCard
            {theme}
            selected={selectedThemeId === theme.id && !selectedThemeIds}
            selectedAppearance={selectedThemeId === theme.id ? activeThemeAppearance : undefined}
            selectedLight={selectedThemeIds ? lightSelected : undefined}
            selectedDark={selectedThemeIds ? darkSelected : undefined}
            onSelect={onThemeSelect}
            onDuplicate={onDuplicateTheme}
            onRemove={onRemoveTheme}
          />
        {/each}
      </div>
    </section>
  </div>
</section>

<style>
  .appearance-option {
    background: var(--app-theme-surface);
    border-color: var(--app-theme-border-subtle);
  }
  .appearance-option:hover { background: color-mix(in srgb, var(--app-theme-text) 4%, var(--app-theme-surface)); }
  .appearance-option[data-selected="true"] { border-color: var(--app-theme-text-muted); }
</style>
