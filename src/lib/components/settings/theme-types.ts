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

const makePalette = (
  palette: Omit<ThemePalette, "sidebarForeground" | "sidebarMutedForeground" | "sidebarBorder" | "sidebarRowHover" | "sidebarRowSelected" | "surfaceRaised" | "surfaceOverlay" | "accentSurface" | "messageSurface" | "messageAction"> &
    Partial<Pick<ThemePalette, "sidebarForeground" | "sidebarMutedForeground" | "sidebarBorder" | "sidebarRowHover" | "sidebarRowSelected" | "surfaceRaised" | "surfaceOverlay" | "accentSurface" | "messageSurface" | "messageAction">>,
): ThemePalette => {
  const surfaceRaised = palette.surfaceRaised ?? palette.surface;
  const accentSurface = palette.accentSurface ?? palette.accent;

  return {
    ...palette,
    sidebarForeground: palette.sidebarForeground ?? palette.text,
    sidebarMutedForeground: palette.sidebarMutedForeground ?? palette.textMuted,
    sidebarBorder: palette.sidebarBorder ?? palette.border,
    sidebarRowHover: palette.sidebarRowHover ?? surfaceRaised,
    sidebarRowSelected: palette.sidebarRowSelected ?? accentSurface,
    surfaceRaised,
    surfaceOverlay: palette.surfaceOverlay ?? surfaceRaised,
    accentSurface,
    messageSurface: palette.messageSurface ?? surfaceRaised,
    messageAction: palette.messageAction ?? palette.accent,
  };
};

const createTheme = (
  id: string,
  label: string,
  light: Parameters<typeof makePalette>[0],
  dark: Parameters<typeof makePalette>[0],
): ThemeDefinition => ({
  id,
  label,
  colors: {
    light: makePalette(light),
    dark: makePalette(dark),
  },
});

/** Standalone visual defaults for the component preview and first integration. */
export const DEFAULT_THEME_DEFINITIONS: readonly ThemeDefinition[] = [
  createTheme(
    "t3-code",
    "T3 Code",
    {
      canvas: "#f7f7f8",
      sidebar: "#f0f0f2",
      surface: "#ffffff",
      text: "#202124",
      textMuted: "#70737b",
      border: "#d9dbe0",
      accent: "#4f46e5",
      accentForeground: "#ffffff",
    },
    {
      canvas: "#0a0a0b",
      sidebar: "#0e0e10",
      surface: "#111113",
      text: "#f4f4f5",
      textMuted: "#92939b",
      border: "#27272c",
      accent: "#8d9cff",
      accentForeground: "#101116",
      sidebarRowSelected: "#1e2030",
    },
  ),
  createTheme(
    "t3-chat",
    "T3 Chat",
    {
      canvas: "#fff7fb",
      sidebar: "#f8e9f1",
      surface: "#ffffff",
      text: "#3c1e2d",
      textMuted: "#9a6d81",
      border: "#efd3e0",
      accent: "#d63c7e",
      accentForeground: "#ffffff",
      accentSurface: "#f8dce8",
    },
    {
      canvas: "#190b14",
      sidebar: "#210e1b",
      surface: "#26101f",
      text: "#fce8f2",
      textMuted: "#c18da5",
      border: "#4d1a36",
      accent: "#ed5c9a",
      accentForeground: "#2a091a",
      accentSurface: "#4a1733",
    },
  ),
  createTheme(
    "grove",
    "Grove",
    {
      canvas: "#f2f8f4",
      sidebar: "#e8f1eb",
      surface: "#ffffff",
      text: "#173a29",
      textMuted: "#6b8876",
      border: "#cfe0d4",
      accent: "#19734a",
      accentForeground: "#ffffff",
      accentSurface: "#d8eee0",
    },
    {
      canvas: "#1d2b24",
      sidebar: "#17231d",
      surface: "#24352b",
      text: "#e6f7eb",
      textMuted: "#94bba0",
      border: "#375340",
      accent: "#69d69a",
      accentForeground: "#0d2417",
      accentSurface: "#2b5a3d",
    },
  ),
  createTheme(
    "ocean",
    "Ocean",
    {
      canvas: "#f2f7fb",
      sidebar: "#e8f1f8",
      surface: "#ffffff",
      text: "#173247",
      textMuted: "#6a879d",
      border: "#cfdfeb",
      accent: "#2878b8",
      accentForeground: "#ffffff",
      accentSurface: "#d9ebf7",
    },
    {
      canvas: "#1b2938",
      sidebar: "#16222e",
      surface: "#223444",
      text: "#e6f3fc",
      textMuted: "#91b1c8",
      border: "#355168",
      accent: "#70b9ee",
      accentForeground: "#0c2537",
      accentSurface: "#294c68",
    },
  ),
  createTheme(
    "ember",
    "Ember",
    {
      canvas: "#fff6ef",
      sidebar: "#faebe0",
      surface: "#ffffff",
      text: "#45271b",
      textMuted: "#a57b63",
      border: "#ecd5c5",
      accent: "#c4602f",
      accentForeground: "#ffffff",
      accentSurface: "#f7dfd0",
    },
    {
      canvas: "#30231e",
      sidebar: "#281d19",
      surface: "#3a2a23",
      text: "#fff0e5",
      textMuted: "#c9a18d",
      border: "#604438",
      accent: "#f39a62",
      accentForeground: "#32180c",
      accentSurface: "#633e2b",
    },
  ),
  createTheme(
    "iris",
    "Iris",
    {
      canvas: "#f7f4fc",
      sidebar: "#eee9f8",
      surface: "#ffffff",
      text: "#302643",
      textMuted: "#8979a8",
      border: "#ded6ef",
      accent: "#7254b9",
      accentForeground: "#ffffff",
      accentSurface: "#e6def8",
    },
    {
      canvas: "#29243b",
      sidebar: "#211d30",
      surface: "#322b48",
      text: "#f1edff",
      textMuted: "#aa9bc9",
      border: "#50466e",
      accent: "#ad92f5",
      accentForeground: "#211733",
      accentSurface: "#4b3d70",
    },
  ),
];
