import { BUILT_IN_THEMES } from "../../theme/themePalette";

export type ThemeAppearance = "light" | "dark";

export type ThemeAppearanceMode = ThemeAppearance | "system";

/**
 * The small, semantic palette used by the preview components.
 *
 * These names intentionally mirror the roles in T3 Code instead of tying the
 * UI to a particular color value. The future runtime can expand this shape
 * without changing the Appearance components' public API.
 */
export type ThemePalette = Readonly<{
  canvas: string;
  sidebar: string;
  sidebarForeground: string;
  sidebarMutedForeground: string;
  sidebarBorder: string;
  sidebarRowHover: string;
  sidebarRowSelected: string;
  surface: string;
  surfaceRaised: string;
  surfaceOverlay: string;
  text: string;
  textMuted: string;
  border: string;
  accent: string;
  accentForeground: string;
  accentSurface: string;
  messageSurface: string;
  messageAction: string;
}>;

export type ThemeDefinition = Readonly<{
  id: string;
  label: string;
  colors: Readonly<{
    light: ThemePalette;
    dark: ThemePalette;
  }>;
  collection?: string;
  managed?: boolean;
  removable?: boolean;
}>;

export type ThemeSelectionHandler = (
  themeId: string,
  appearance: ThemeAppearanceMode,
) => void;

export type AppearanceModeChangeHandler = (mode: ThemeAppearanceMode) => void;

/** The settings fallback uses the same definitions as the live theme runtime. */
export const DEFAULT_THEME_DEFINITIONS: readonly ThemeDefinition[] = BUILT_IN_THEMES.map((theme) => ({
  id: theme.id,
  label: theme.label,
  colors: {
    light: theme.colors,
    dark: theme.variants?.dark ?? theme.colors,
  },
}));
