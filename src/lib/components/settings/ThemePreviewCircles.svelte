<script lang="ts">
  import { Moon, Sun } from "@lucide/svelte";
  import type { ThemeAppearance, ThemeAppearanceMode, ThemeDefinition, ThemePalette } from "./theme-types";

  type Props = {
    theme: ThemeDefinition;
    selected?: boolean;
    selectedAppearance?: ThemeAppearanceMode;
    selectedLight?: boolean;
    selectedDark?: boolean;
    onSelect?: (appearance: ThemeAppearance) => void;
  };

  let {
    theme,
    selected = false,
    selectedAppearance = "system",
    selectedLight,
    selectedDark,
    onSelect,
  }: Props = $props();

  const swatches = $derived([
    { appearance: "light" as const, label: "Light", palette: theme.colors.light },
    { appearance: "dark" as const, label: "Dark", palette: theme.colors.dark },
  ] satisfies Array<{ appearance: ThemeAppearance; label: string; palette: ThemePalette }>);

  function swatchStyle(palette: ThemePalette, appearance: ThemeAppearance) {
    const glow = appearance === "light" ? palette.surface : palette.text;

    return [
      `background: radial-gradient(circle at 31% 24%, color-mix(in srgb, ${glow} 84%, ${palette.accent}) 0%, ${palette.accent} 49%, ${palette.canvas} 100%)`,
      `box-shadow: inset 0 0 0 1px color-mix(in srgb, ${palette.text} 22%, transparent)`,
    ].join(";");
  }

  function indicatorStyle(palette: ThemePalette) {
    return `background: ${palette.surfaceRaised}; color: ${palette.text}; border-color: ${palette.border}`;
  }

  function isSwatchSelected(appearance: ThemeAppearance) {
    if (appearance === "light" && selectedLight !== undefined) return selectedLight;
    if (appearance === "dark" && selectedDark !== undefined) return selectedDark;
    return selected && (selectedAppearance === appearance || selectedAppearance === "system");
  }
</script>

<div class="flex items-center justify-center gap-5 sm:gap-6" aria-label={`${theme.label} color variants`}>
  {#each swatches as swatch (swatch.appearance)}
    {@const isSelected = isSwatchSelected(swatch.appearance)}
    <button
      type="button"
      class="group relative h-[76px] w-[76px] rounded-full transition duration-200 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus,#4c8dff)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--app-theme-surface,#101012)]"
      aria-label={`Use ${theme.label} ${swatch.label} theme`}
      aria-pressed={isSelected}
      style={`${swatchStyle(swatch.palette, swatch.appearance)}; ${isSelected ? "outline: 2px solid var(--app-theme-focus, #4c8dff); outline-offset: 4px" : ""}`}
      onclick={() => onSelect?.(swatch.appearance)}
    >
      <span
        class="absolute -right-1 -bottom-1 flex h-6 w-6 items-center justify-center rounded-full border shadow-sm"
        style={indicatorStyle(swatch.palette)}
      >
        {#if swatch.appearance === "light"}
          <Sun aria-hidden="true" size={13} strokeWidth={2.2} />
        {:else}
          <Moon aria-hidden="true" size={12} strokeWidth={2.2} />
        {/if}
      </span>
    </button>
  {/each}
</div>
