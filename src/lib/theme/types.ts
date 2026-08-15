/**
 * The semantic palette contract used by GitGui's theme runtime.
 *
 * These role names intentionally follow T3 Code's palette model. Components
 * should consume roles instead of knowing which concrete color a surface uses.
 */
export const THEME_COLOR_ROLES = [
  "canvas",
  "chrome",
  "toolbar",
  "toolbarForeground",
  "toolbarBorder",
  "toolbarControl",
  "toolbarControlForeground",
  "toolbarControlHover",
  "surface",
  "surfaceRaised",
  "surfaceOverlay",
  "text",
  "textMuted",
  "border",
  "input",
  "focus",
  "accent",
  "accentForeground",
  "secondary",
  "secondaryForeground",
  "muted",
  "mutedForeground",
  "placeholder",
  "secondaryLabel",
  "iconMuted",
  "error",
  "errorForeground",
  "errorSurface",
  "warning",
  "warningForeground",
  "warningSurface",
  "update",
  "updateForeground",
  "updateSurface",
  "accentSurface",
  "accentSurfaceForeground",
  "messageSurface",
  "messageForeground",
  "messageAction",
  "messageActionForeground",
  "messageActionHover",
  "codeBackground",
  "codeForeground",
  "sidebar",
  "sidebarForeground",
  "sidebarMutedForeground",
  "sidebarControlSurface",
  "sidebarRowHover",
  "sidebarRowActive",
  "sidebarRowSelected",
  "sidebarBorder",
  "terminalBackground",
  "terminalForeground",
  "terminalCursor",
  "terminalSelection",
  "terminalScrollbar",
  "terminalScrollbarHover",
] as const;

export type ThemeColorRole = (typeof THEME_COLOR_ROLES)[number];
export type ThemeAppearance = "light" | "dark";
export type ThemePreferenceMode = ThemeAppearance | "system";
export type ThemeColors = Readonly<Record<ThemeColorRole, string>>;
export type ThemeColorOverrides = Readonly<Partial<Record<ThemeColorRole, string>>>;
export type ThemeVariants = Readonly<Partial<Record<ThemeAppearance, ThemeColors>>>;
export type ThemeVariantOverrides = Readonly<
  Partial<Record<ThemeAppearance, ThemeColorOverrides>>
>;

export type ThemeCollection = Readonly<{
  id: string;
  label: string;
}>;

export type ThemeDefinition = Readonly<{
  id: string;
  label: string;
  appearance: ThemeAppearance;
  colors: ThemeColors;
  variants?: ThemeVariants;
  collection?: ThemeCollection;
  /** Reserved for future maintainer-controlled sidebar artwork. */
  sidebarArtwork?: boolean;
  /** True when the palette came from a guided seed-based editor. */
  managed?: boolean;
}>;

export type ThemeFile = Readonly<{
  version: typeof THEME_FILE_VERSION;
  id: string;
  name: string;
  appearance: ThemeAppearance;
  colors: ThemeColorOverrides;
  variants?: ThemeVariantOverrides;
  collection?: ThemeCollection;
  managed?: boolean;
}>;

export type ThemeHalves = Readonly<Partial<Record<ThemeAppearance, string>>>;

export type ThemeSnapshot = Readonly<{
  /** The selected palette id. */
  theme: string;
  /** The operating-system preference, when available. */
  systemDark: boolean;
  appearanceMode: ThemePreferenceMode;
  followSystem: boolean;
  /** The appearance currently painted onto the document. */
  resolvedAppearance: ThemeAppearance;
  /** Alias matching the T3 hook's consumer-facing terminology. */
  resolvedTheme: ThemeAppearance;
  themeHalves: ThemeHalves | null;
}>;

export type ThemeListener = (snapshot: ThemeSnapshot) => void;

export type ThemeStore = Readonly<{
  subscribe: (listener: ThemeListener) => () => void;
  getSnapshot: () => ThemeSnapshot;
  setTheme: (themeId: string) => boolean;
  setAppearanceMode: (mode: ThemePreferenceMode) => boolean;
  setFollowSystem: (followSystem: boolean) => boolean;
  setThemeHalf: (appearance: ThemeAppearance, themeId: string | null) => boolean;
  clearThemeHalves: () => boolean;
  refreshTheme: () => void;
}>;

export const THEME_FILE_VERSION = 1 as const;
export const DEFAULT_THEME_ID = "t3-code" as const;

export const THEME_STORAGE_KEY = "gitgui:theme";
export const THEME_APPEARANCE_MODE_STORAGE_KEY = "gitgui:theme-appearance-mode";
export const THEME_HALVES_STORAGE_KEY = "gitgui:theme-halves:v1";
export const CUSTOM_THEMES_STORAGE_KEY = "gitgui:themes:v1";

export const THEME_PREVIEW_ID = "__preview" as const;

export const APP_THEME_VARIABLES: Readonly<Record<ThemeColorRole, string>> = {
  canvas: "--app-theme-canvas",
  chrome: "--app-theme-chrome",
  toolbar: "--app-theme-toolbar",
  toolbarForeground: "--app-theme-toolbar-foreground",
  toolbarBorder: "--app-theme-toolbar-border",
  toolbarControl: "--app-theme-toolbar-control",
  toolbarControlForeground: "--app-theme-toolbar-control-foreground",
  toolbarControlHover: "--app-theme-toolbar-control-hover",
  surface: "--app-theme-surface",
  surfaceRaised: "--app-theme-surface-raised",
  surfaceOverlay: "--app-theme-surface-overlay",
  text: "--app-theme-text",
  textMuted: "--app-theme-text-muted",
  border: "--app-theme-border",
  input: "--app-theme-input",
  focus: "--app-theme-focus",
  accent: "--app-theme-accent",
  accentForeground: "--app-theme-accent-foreground",
  secondary: "--app-theme-secondary",
  secondaryForeground: "--app-theme-secondary-foreground",
  muted: "--app-theme-muted",
  mutedForeground: "--app-theme-muted-foreground",
  placeholder: "--app-theme-placeholder",
  secondaryLabel: "--app-theme-secondary-label",
  iconMuted: "--app-theme-icon-muted",
  error: "--app-theme-error",
  errorForeground: "--app-theme-error-foreground",
  errorSurface: "--app-theme-error-surface",
  warning: "--app-theme-warning",
  warningForeground: "--app-theme-warning-foreground",
  warningSurface: "--app-theme-warning-surface",
  update: "--app-theme-update",
  updateForeground: "--app-theme-update-foreground",
  updateSurface: "--app-theme-update-surface",
  accentSurface: "--app-theme-accent-surface",
  accentSurfaceForeground: "--app-theme-accent-surface-foreground",
  messageSurface: "--app-theme-message-surface",
  messageForeground: "--app-theme-message-foreground",
  messageAction: "--app-theme-message-action",
  messageActionForeground: "--app-theme-message-action-foreground",
  messageActionHover: "--app-theme-message-action-hover",
  codeBackground: "--app-theme-code-background",
  codeForeground: "--app-theme-code-foreground",
  sidebar: "--app-theme-sidebar",
  sidebarForeground: "--app-theme-sidebar-foreground",
  sidebarMutedForeground: "--app-theme-sidebar-muted-foreground",
  sidebarControlSurface: "--app-theme-sidebar-control-surface",
  sidebarRowHover: "--app-theme-sidebar-row-hover",
  sidebarRowActive: "--app-theme-sidebar-row-active",
  sidebarRowSelected: "--app-theme-sidebar-row-selected",
  sidebarBorder: "--app-theme-sidebar-border",
  terminalBackground: "--app-theme-terminal-background",
  terminalForeground: "--app-theme-terminal-foreground",
  terminalCursor: "--app-theme-terminal-cursor",
  terminalSelection: "--app-theme-terminal-selection-background",
  terminalScrollbar: "--app-theme-terminal-scrollbar",
  terminalScrollbarHover: "--app-theme-terminal-scrollbar-hover",
};
