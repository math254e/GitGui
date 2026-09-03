<script lang="ts">
  import { Plus, Upload } from "@lucide/svelte";
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
  const previewTheme = $derived(
    availableThemes.find((theme) => theme.id === selectedThemeId) ?? availableThemes[0],
  );

  function selectAppearance(mode: ThemeAppearanceMode) {
    onAppearanceModeChange?.(mode);
  }
</script>

<section
  class={`min-h-full w-full px-5 py-8 text-[var(--app-theme-text,#f4f4f5)] sm:px-8 sm:py-10 lg:px-12 lg:py-12 ${className}`}
  style="background: var(--app-theme-canvas, #0a0a0b)"
>
  <div class="mx-auto max-w-[1080px]">
    <header class="max-w-[760px]">
      <h1 class="text-[26px] font-semibold tracking-[-0.035em] sm:text-[28px]">{heading}</h1>
      <p class="mt-3 text-sm leading-6 text-[var(--app-theme-text-muted,#92939b)] sm:text-[15px]">{description}</p>
    </header>

    <section class="mt-8" aria-labelledby="theme-color-scheme-heading">
      <h2 id="theme-color-scheme-heading" class="text-[17px] font-semibold tracking-[-0.02em]">Color scheme</h2>

      <div class="mt-4 grid gap-4 md:grid-cols-3">
        {#each schemeOptions as option (option.id)}
          {@const isSelected = appearanceMode === option.id}
          <button
            type="button"
            class="group min-w-0 rounded-2xl border p-2.5 text-left transition duration-200 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus,#4c8dff)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--app-theme-canvas,#0a0a0b)]"
            aria-pressed={isSelected}
            aria-label={`${option.label}: ${option.description}`}
            style={`background: var(--app-theme-surface, #101012); border-color: ${isSelected ? "var(--app-theme-focus, #4c8dff)" : "var(--app-theme-border, #27272c)"}; box-shadow: ${isSelected ? "0 0 0 1px color-mix(in srgb, var(--app-theme-focus, #4c8dff) 34%, transparent)" : "none"}`}
            onclick={() => selectAppearance(option.id)}
          >
            <div class="h-[174px] sm:h-[182px]">
              <ThemeWireframe
                mode={option.id}
                lightPalette={previewTheme.colors.light}
                darkPalette={previewTheme.colors.dark}
              />
            </div>
            <div class="px-1 pb-1 pt-3 text-center">
              <span class={`text-sm font-semibold ${isSelected ? "text-[var(--app-theme-text,#f4f4f5)]" : "text-[var(--app-theme-text-muted,#92939b)]"}`}>
                {option.label}
              </span>
            </div>
          </button>
        {/each}
      </div>
    </section>

    <section class="mt-8" aria-labelledby="themes-heading">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 id="themes-heading" class="text-[17px] font-semibold tracking-[-0.02em]">Themes</h2>

        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-sm font-semibold transition hover:bg-[var(--app-theme-surface-raised,#17171a)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus,#4c8dff)]"
            style="color: var(--app-theme-text); border-color: var(--app-theme-border, #27272c)"
            onclick={() => onCreateTheme?.()}
          >
            <Plus aria-hidden="true" size={15} strokeWidth={2} />
            Create theme
          </button>
          <button
            type="button"
            class="inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-sm font-semibold transition hover:bg-[var(--app-theme-surface-raised,#17171a)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus,#4c8dff)]"
            style="color: var(--app-theme-text); border-color: var(--app-theme-border, #27272c)"
            onclick={() => onImportTheme?.()}
          >
            <Upload aria-hidden="true" size={15} strokeWidth={2} />
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
