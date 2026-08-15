import {
  APP_THEME_VARIABLES,
  CUSTOM_THEMES_STORAGE_KEY,
  DEFAULT_THEME_ID,
  THEME_COLOR_ROLES,
  THEME_FILE_VERSION,
  THEME_PREVIEW_ID,
  type ThemeAppearance,
  type ThemeCollection,
  type ThemeColorOverrides,
  type ThemeColorRole,
  type ThemeColors,
  type ThemeDefinition,
  type ThemeFile,
  type ThemeHalves,
  type ThemePreferenceMode,
  type ThemeVariants,
} from "./types";

export * from "./types";

const THEME_COLOR_ROLE_SET: ReadonlySet<string> = new Set(THEME_COLOR_ROLES);
const RESERVED_THEME_IDS = new Set(["system", "light", "dark", DEFAULT_THEME_ID]);
const customThemeListeners = new Set<() => void>();
let customThemeCache: ReadonlyArray<ThemeDefinition> | null = null;

type Rgb = Readonly<{ r: number; g: number; b: number }>;

type ThemeSeed = Readonly<{
  lightCanvas: string;
  lightAccent: string;
  darkCanvas: string;
  darkAccent: string;
}>;

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function parseHexColor(value: string): Rgb {
  const hex = value.slice(1);
  const expanded = hex.length <= 4 ? hex.split("").map((part) => part + part).join("") : hex;
  return {
    r: Number.parseInt(expanded.slice(0, 2), 16),
    g: Number.parseInt(expanded.slice(2, 4), 16),
    b: Number.parseInt(expanded.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b]
    .map((channel) => Math.round(clamp(channel / 255) * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

function mixHex(first: string, second: string, amount: number): string {
  const a = parseHexColor(first);
  const b = parseHexColor(second);
  const ratio = clamp(amount);
  return rgbToHex({
    r: a.r + (b.r - a.r) * ratio,
    g: a.g + (b.g - a.g) * ratio,
    b: a.b + (b.b - a.b) * ratio,
  });
}

function channelToLinear(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.03928
    ? normalized / 12.92
    : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

function relativeLuminance(value: string): number {
  const { r, g, b } = parseHexColor(value);
  return 0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b);
}

function readableForeground(background: string): string {
  const luminance = relativeLuminance(background);
  const lightContrast = 1.05 / (luminance + 0.05);
  const darkContrast = (luminance + 0.05) / 0.05;
  return lightContrast >= darkContrast ? "#ffffff" : "#17191c";
}

function createThemeColors(
  appearance: ThemeAppearance,
  canvas: string,
  accent: string,
): ThemeColors {
  const isLight = appearance === "light";
  const white = "#ffffff";
  const black = "#111418";
  const text = isLight ? readableForeground(canvas) : "#f7f8fa";
  const surface = isLight ? mixHex(canvas, white, 0.46) : mixHex(canvas, white, 0.08);
  const raised = isLight ? mixHex(canvas, white, 0.74) : mixHex(canvas, white, 0.13);
  const mutedSurface = isLight ? mixHex(canvas, text, 0.07) : mixHex(canvas, white, 0.18);
  const secondary = isLight ? mixHex(canvas, accent, 0.14) : mixHex(canvas, white, 0.11);
  const accentSurface = isLight ? mixHex(canvas, accent, 0.12) : mixHex(canvas, accent, 0.25);
  const error = isLight ? "#b42318" : "#f97066";
  const warning = isLight ? "#b54708" : "#f6c344";
  const update = isLight ? accent : mixHex(accent, white, 0.1);

  return {
    canvas,
    chrome: canvas,
    toolbar: canvas,
    toolbarForeground: text,
    toolbarBorder: isLight ? mixHex(canvas, text, 0.12) : mixHex(canvas, white, 0.14),
    toolbarControl: isLight ? mixHex(canvas, accent, 0.08) : mixHex(canvas, white, 0.1),
    toolbarControlForeground: text,
    toolbarControlHover: isLight ? mixHex(canvas, accent, 0.15) : mixHex(canvas, accent, 0.3),
    surface,
    surfaceRaised: raised,
    surfaceOverlay: isLight ? white : mixHex(canvas, black, 0.45),
    text,
    textMuted: isLight ? mixHex(text, canvas, 0.48) : mixHex(text, canvas, 0.36),
    border: isLight ? mixHex(canvas, text, 0.12) : mixHex(canvas, white, 0.15),
    input: isLight ? mixHex(canvas, accent, 0.08) : mixHex(canvas, white, 0.1),
    focus: accent,
    accent,
    accentForeground: readableForeground(accent),
    secondary,
    secondaryForeground: readableForeground(secondary),
    muted: mutedSurface,
    mutedForeground: isLight ? mixHex(text, canvas, 0.34) : mixHex(text, canvas, 0.42),
    placeholder: isLight ? mixHex(text, canvas, 0.58) : mixHex(text, canvas, 0.54),
    secondaryLabel: isLight ? mixHex(text, canvas, 0.3) : mixHex(text, canvas, 0.26),
    iconMuted: isLight ? mixHex(text, canvas, 0.4) : mixHex(text, canvas, 0.34),
    error,
    errorForeground: readableForeground(error),
    errorSurface: isLight ? mixHex(canvas, error, 0.1) : mixHex(canvas, error, 0.22),
    warning,
    warningForeground: readableForeground(warning),
    warningSurface: isLight ? mixHex(canvas, warning, 0.1) : mixHex(canvas, warning, 0.2),
    update,
    updateForeground: readableForeground(update),
    updateSurface: isLight ? mixHex(canvas, update, 0.1) : mixHex(canvas, update, 0.22),
    accentSurface,
    accentSurfaceForeground: readableForeground(accentSurface),
    messageSurface: isLight ? mixHex(canvas, accent, 0.1) : mixHex(canvas, accent, 0.17),
    messageForeground: text,
    messageAction: accent,
    messageActionForeground: readableForeground(accent),
    messageActionHover: isLight ? mixHex(accent, black, 0.12) : mixHex(accent, white, 0.12),
    codeBackground: isLight ? mixHex(canvas, text, 0.05) : mixHex(canvas, black, 0.08),
    codeForeground: isLight ? mixHex(text, accent, 0.18) : mixHex(text, accent, 0.22),
    sidebar: isLight ? mixHex(canvas, accent, 0.035) : mixHex(canvas, black, 0.12),
    sidebarForeground: text,
    sidebarMutedForeground: isLight ? mixHex(text, canvas, 0.42) : mixHex(text, canvas, 0.4),
    sidebarControlSurface: isLight ? mixHex(canvas, accent, 0.07) : mixHex(canvas, white, 0.1),
    sidebarRowHover: isLight ? mixHex(canvas, accent, 0.08) : mixHex(canvas, white, 0.09),
    sidebarRowActive: isLight ? mixHex(canvas, accent, 0.12) : mixHex(canvas, white, 0.13),
    sidebarRowSelected: accentSurface,
    sidebarBorder: isLight ? mixHex(canvas, text, 0.1) : mixHex(canvas, white, 0.14),
    terminalBackground: isLight ? mixHex(canvas, text, 0.08) : mixHex(canvas, black, 0.2),
    terminalForeground: isLight ? mixHex(text, accent, 0.1) : mixHex(text, accent, 0.16),
    terminalCursor: accent,
    terminalSelection: isLight ? mixHex(canvas, accent, 0.2) : mixHex(canvas, accent, 0.32),
    terminalScrollbar: isLight ? mixHex(canvas, text, 0.2) : mixHex(canvas, white, 0.2),
    terminalScrollbarHover: isLight ? mixHex(canvas, text, 0.3) : mixHex(canvas, white, 0.3),
  };
}

function createManagedTheme(seed: ThemeSeed, id: string, label: string): ThemeDefinition {
  return {
    id,
    label,
    appearance: "light",
    colors: createThemeColors("light", seed.lightCanvas, seed.lightAccent),
    variants: {
      dark: createThemeColors("dark", seed.darkCanvas, seed.darkAccent),
    },
  };
}

/**
 * The flagship T3 Code palette, copied from the installed T3 implementation's
 * standard theme definitions. GitGui keeps the same role names and variants so
 * the Appearance screen and runtime behave like the source application.
 */
export const T3_CODE_THEME: ThemeDefinition = {
  id: "t3-code",
  label: "T3 Code",
  appearance: "light",
  colors: {
    canvas: "#fcfcfc",
    chrome: "#fcfcfc",
    toolbar: "#fcfcfc",
    toolbarForeground: "#27272a",
    toolbarBorder: "#e4e4e7",
    toolbarControl: "#ffffff",
    toolbarControlForeground: "#27272a",
    toolbarControlHover: "#f4f4f5",
    surface: "#ffffff",
    surfaceRaised: "#fcfcfc",
    surfaceOverlay: "#ffffff",
    text: "#27272a",
    textMuted: "#71717b",
    border: "#e4e4e7",
    input: "#d4d4d8",
    focus: "#1b4ed8",
    accent: "#1b4ed8",
    accentForeground: "#ffffff",
    secondary: "#fafafa",
    secondaryForeground: "#27272a",
    muted: "#fafafa",
    mutedForeground: "#71717b",
    placeholder: "#71717b",
    secondaryLabel: "#71717b",
    iconMuted: "#71717b",
    error: "#fb2c36",
    errorForeground: "#c10007",
    errorSurface: "#fcebec",
    warning: "#fe9a00",
    warningForeground: "#bb4d00",
    warningSurface: "#fcf4e8",
    update: "#1b4ed8",
    updateForeground: "#1b4ed8",
    updateSurface: "#e0e6f7",
    accentSurface: "#f4f4f5",
    accentSurfaceForeground: "#18181b",
    messageSurface: "#f4f4f5",
    messageForeground: "#27272a",
    messageAction: "#1b4ed8",
    messageActionForeground: "#ffffff",
    messageActionHover: "#3160db",
    codeBackground: "#ffffff",
    codeForeground: "#27272a",
    sidebar: "#fafafa",
    sidebarForeground: "#27272a",
    sidebarMutedForeground: "#71717b",
    sidebarControlSurface: "#f4f4f5",
    sidebarRowHover: "#fcfcfc",
    sidebarRowActive: "#ffffff",
    sidebarRowSelected: "#ffffff",
    sidebarBorder: "#e4e4e7",
    terminalBackground: "#fcfcfc",
    terminalForeground: "#27272a",
    terminalCursor: "#26384e",
    terminalSelection: "#d0d6dd",
    terminalScrollbar: "#d6d6d6",
    terminalScrollbarHover: "#bdbdbd",
  },
  variants: {
    dark: {
      canvas: "#0a0a0a",
      chrome: "#0a0a0a",
      toolbar: "#0a0a0a",
      toolbarForeground: "#f5f5f5",
      toolbarBorder: "#191919",
      toolbarControl: "#191919",
      toolbarControlForeground: "#f5f5f5",
      toolbarControlHover: "#141414",
      surface: "#111111",
      surfaceRaised: "#141414",
      surfaceOverlay: "#191919",
      text: "#f5f5f5",
      textMuted: "#818181",
      border: "#191919",
      input: "#1e1e1e",
      focus: "#346bf1",
      accent: "#346bf1",
      accentForeground: "#ffffff",
      secondary: "#141414",
      secondaryForeground: "#f5f5f5",
      muted: "#141414",
      mutedForeground: "#818181",
      placeholder: "#818181",
      secondaryLabel: "#818181",
      iconMuted: "#818181",
      error: "#fb414a",
      errorForeground: "#ff6467",
      errorSurface: "#301214",
      warning: "#fe9a00",
      warningForeground: "#ffb900",
      warningSurface: "#312108",
      update: "#346bf1",
      updateForeground: "#51a2ff",
      updateSurface: "#121b34",
      accentSurface: "#141414",
      accentSurfaceForeground: "#f5f5f5",
      messageSurface: "#141414",
      messageForeground: "#f5f5f5",
      messageAction: "#346bf1",
      messageActionForeground: "#ffffff",
      messageActionHover: "#3061d9",
      codeBackground: "#111111",
      codeForeground: "#f5f5f5",
      sidebar: "#000000",
      sidebarForeground: "#f1f3f7",
      sidebarMutedForeground: "#a3a3a3",
      sidebarControlSurface: "#0a0a0a",
      sidebarRowHover: "#131313",
      sidebarRowActive: "#1a1b1b",
      sidebarRowSelected: "#111111",
      sidebarBorder: "#141414",
      terminalBackground: "#0a0a0a",
      terminalForeground: "#f5f5f5",
      terminalCursor: "#b4cbff",
      terminalSelection: "#343a47",
      terminalScrollbar: "#222222",
      terminalScrollbarHover: "#363636",
    },
  },
};

/** The T3 Chat companion palette shown beside T3 Code in the library. */
export const T3_CHAT_THEME: ThemeDefinition = {
  id: "t3-chat",
  label: "T3 Chat",
  appearance: "light",
  colors: {
    canvas: "#fdf7fd",
    chrome: "#fdf7fd",
    toolbar: "#fdf7fd",
    toolbarForeground: "#501854",
    toolbarBorder: "#efbdeb",
    toolbarControl: "#f3e6f5",
    toolbarControlForeground: "#501854",
    toolbarControlHover: "#eccfe3",
    surface: "#faf3fb",
    surfaceRaised: "#fdfafd",
    surfaceOverlay: "#ffffff",
    text: "#501854",
    textMuted: "#ac1668",
    border: "#eee1ed",
    input: "#e7c1dc",
    focus: "#db2777",
    accent: "#db2777",
    accentForeground: "#ffffff",
    secondary: "#f1c4e6",
    secondaryForeground: "#77347c",
    muted: "#eaa7cb",
    mutedForeground: "#8d1255",
    placeholder: "#8b5f90",
    secondaryLabel: "#ac1668",
    iconMuted: "#ac1668",
    error: "#f7086c",
    errorForeground: "#9d174d",
    errorSurface: "#fde4f1",
    warning: "#f59e0b",
    warningForeground: "#b05109",
    warningSurface: "#fcf0ea",
    update: "#db2777",
    updateForeground: "#ac1668",
    updateSurface: "#fadfef",
    accentSurface: "#f3e6f5",
    accentSurfaceForeground: "#454554",
    messageSurface: "#f7def2",
    messageForeground: "#492c61",
    messageAction: "#db2777",
    messageActionForeground: "#ffffff",
    messageActionHover: "#c12269",
    codeBackground: "#f5ecf9",
    codeForeground: "#673c8b",
    sidebar: "#f2e1f4",
    sidebarForeground: "#454554",
    sidebarMutedForeground: "#ac1668",
    sidebarControlSurface: "#f8f8f7",
    sidebarRowHover: "#f8f8f7",
    sidebarRowActive: "#f8f8f7",
    sidebarRowSelected: "#f8f8f7",
    sidebarBorder: "#eceae9",
    terminalBackground: "#fdf7fd",
    terminalForeground: "#501854",
    terminalCursor: "#db2777",
    terminalSelection: "#f1c4e6",
    terminalScrollbar: "#e7c1dc",
    terminalScrollbarHover: "#eaa7cb",
  },
  variants: {
    dark: {
      canvas: "#1f1a24",
      chrome: "#1f1a24",
      toolbar: "#1f1a24",
      toolbarForeground: "#f9f8fb",
      toolbarBorder: "#27242c",
      toolbarControl: "#362d3d",
      toolbarControlForeground: "#d4c7e1",
      toolbarControlHover: "#463753",
      surface: "#29232d",
      surfaceRaised: "#2c2631",
      surfaceOverlay: "#100a0e",
      text: "#f9f8fb",
      textMuted: "#e7d0dd",
      border: "#27242c",
      input: "#302029",
      focus: "#db2777",
      accent: "#a3004c",
      accentForeground: "#fbd0e8",
      secondary: "#362d3d",
      secondaryForeground: "#d4c7e1",
      muted: "#423a45",
      mutedForeground: "#e7d0dd",
      placeholder: "#968d9f",
      secondaryLabel: "#e7d0dd",
      iconMuted: "#d4c7e1",
      error: "#9d174d",
      errorForeground: "#fbd0e8",
      errorSurface: "#331a2b",
      warning: "#f59e0b",
      warningForeground: "#fbbf24",
      warningSurface: "#412f20",
      update: "#a3004c",
      updateForeground: "#fbd0e8",
      updateSurface: "#37152b",
      accentSurface: "#463753",
      accentSurfaceForeground: "#f8f1f5",
      messageSurface: "#2b2431",
      messageForeground: "#f2ebfa",
      messageAction: "#a3004c",
      messageActionForeground: "#fbd0e8",
      messageActionHover: "#a2004c",
      codeBackground: "#1f1a24",
      codeForeground: "#d8c3ef",
      sidebar: "#171018",
      sidebarForeground: "#f4f4f5",
      sidebarMutedForeground: "#e7d0dd",
      sidebarControlSurface: "#261922",
      sidebarRowHover: "#261922",
      sidebarRowActive: "#261922",
      sidebarRowSelected: "#261922",
      sidebarBorder: "#322028",
      terminalBackground: "#1f1a24",
      terminalForeground: "#f9f8fb",
      terminalCursor: "#db2777",
      terminalSelection: "#362d3d",
      terminalScrollbar: "#302029",
      terminalScrollbarHover: "#423a45",
    },
  },
  sidebarArtwork: true,
};

export const OCEAN_THEME = createManagedTheme(
  {
    lightCanvas: "#f2f7fb",
    lightAccent: "#2878b8",
    darkCanvas: "#1b2938",
    darkAccent: "#70b9ee",
  },
  "ocean",
  "Ocean",
);

export const EMBER_THEME = createManagedTheme(
  {
    lightCanvas: "#fff6ef",
    lightAccent: "#c4602f",
    darkCanvas: "#30231e",
    darkAccent: "#f39a62",
  },
  "ember",
  "Ember",
);

export const GROVE_THEME = createManagedTheme(
  {
    lightCanvas: "#f2f8f4",
    lightAccent: "#19734a",
    darkCanvas: "#1d2b24",
    darkAccent: "#69d69a",
  },
  "grove",
  "Grove",
);

export const IRIS_THEME = createManagedTheme(
  {
    lightCanvas: "#f7f4fc",
    lightAccent: "#7254b9",
    darkCanvas: "#29243b",
    darkAccent: "#ad92f5",
  },
  "iris",
  "Iris",
);

export const BUILT_IN_THEMES: ReadonlyArray<ThemeDefinition> = [
  T3_CODE_THEME,
  T3_CHAT_THEME,
  GROVE_THEME,
  OCEAN_THEME,
  EMBER_THEME,
  IRIS_THEME,
];

const DEFAULT_THEME_COLORS: Readonly<Record<ThemeAppearance, ThemeColors>> = {
  light: T3_CHAT_THEME.colors,
  dark: T3_CHAT_THEME.variants!.dark!,
};

export function getDefaultThemeColors(appearance: ThemeAppearance): ThemeColors {
  return DEFAULT_THEME_COLORS[appearance];
}

export function getThemeColorVariable(role: ThemeColorRole): string {
  return APP_THEME_VARIABLES[role];
}

export function isThemeAppearance(value: unknown): value is ThemeAppearance {
  return value === "light" || value === "dark";
}

export function isThemePreferenceMode(value: unknown): value is ThemePreferenceMode {
  return value === "light" || value === "dark" || value === "system";
}

export function isThemeId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,47})$/.test(value);
}

export function themeIdFromName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || "custom-theme";
}

function isThemeLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 48;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * T3 canonicalizes colors through culori. GitGui intentionally has no new
 * dependency for this foundation, so this adapter validates safe CSS colors
 * and preserves their authoring notation for round-tripping.
 */
export function toCanonicalThemeColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 128 ||
    /[;{}<>\r\n]/.test(normalized)
  ) {
    return null;
  }

  if (typeof CSS !== "undefined" && typeof CSS.supports === "function") {
    return CSS.supports("color", normalized) ? normalized : null;
  }

  return /^(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([^()]+\)|[a-z]+)$/i.test(
    normalized,
  )
    ? normalized
    : null;
}

export function isThemeColor(value: unknown): value is string {
  return toCanonicalThemeColor(value) !== null;
}

function parseThemeCollection(value: unknown): ThemeCollection | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || !isThemeLabel(value.label)) {
    return undefined;
  }
  if (!/^[a-z0-9][a-z0-9.:-]{0,127}$/i.test(value.id)) return undefined;
  return { id: value.id, label: value.label.trim() };
}

function parseThemeColorOverrides(value: unknown, strict = true): ThemeColorOverrides {
  if (!isRecord(value)) throw new Error("Theme colors must be an object.");
  const overrides: Partial<Record<ThemeColorRole, string>> = {};

  for (const [role, color] of Object.entries(value)) {
    if (!THEME_COLOR_ROLE_SET.has(role)) {
      if (strict) throw new Error(`"${role}" is not a supported theme color role.`);
      continue;
    }
    const normalized = toCanonicalThemeColor(color);
    if (!normalized) {
      if (strict) throw new Error(`The color for "${role}" is not a valid CSS color.`);
      continue;
    }
    overrides[role as ThemeColorRole] = normalized;
  }

  if (strict && Object.keys(overrides).length === 0) {
    throw new Error("Add at least one color role to the theme file.");
  }
  return overrides;
}

function mergeThemeColors(
  appearance: ThemeAppearance,
  colors: unknown,
  strict = false,
): ThemeColors | null {
  if (!isRecord(colors)) return null;
  const overrides = parseThemeColorOverrides(colors, strict);
  return { ...getDefaultThemeColors(appearance), ...overrides };
}

function parseStoredTheme(value: unknown): ThemeDefinition | null {
  if (!isRecord(value)) return null;
  if (!isThemeId(value.id) || RESERVED_THEME_IDS.has(value.id)) return null;
  if (!isThemeLabel(value.label) || !isThemeAppearance(value.appearance)) return null;

  const colors = mergeThemeColors(value.appearance, value.colors);
  if (!colors) return null;

  let variants: ThemeVariants | undefined;
  if (value.variants !== undefined) {
    if (!isRecord(value.variants)) return null;
    const parsed: Partial<Record<ThemeAppearance, ThemeColors>> = {};
    for (const appearance of ["light", "dark"] as const) {
      if (appearance === value.appearance || value.variants[appearance] === undefined) continue;
      const variantColors = mergeThemeColors(appearance, value.variants[appearance]);
      if (!variantColors) return null;
      parsed[appearance] = variantColors;
    }
    if (Object.keys(parsed).length > 0) variants = parsed;
  }

  return {
    id: value.id,
    label: value.label.trim(),
    appearance: value.appearance,
    colors,
    ...(variants ? { variants } : {}),
    ...(parseThemeCollection(value.collection)
      ? { collection: parseThemeCollection(value.collection) }
      : {}),
    ...(value.managed === true ? { managed: true } : {}),
  };
}

function parseStoredThemes(value: unknown): ReadonlyArray<ThemeDefinition> {
  if (!Array.isArray(value)) return [];
  const themes: ThemeDefinition[] = [];
  for (const item of value) {
    const theme = parseStoredTheme(item);
    if (theme && !themes.some((existing) => existing.id === theme.id)) themes.push(theme);
  }
  return themes;
}

function readStoredThemeLibrary(): { raw: ReadonlyArray<unknown>; themes: ReadonlyArray<ThemeDefinition> } {
  if (typeof window === "undefined") return { raw: [], themes: [] };
  try {
    const value = window.localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY);
    if (!value) return { raw: [], themes: [] };
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? { raw: parsed, themes: parseStoredThemes(parsed) }
      : { raw: [], themes: [] };
  } catch {
    return { raw: [], themes: [] };
  }
}

function getCustomThemeLibrary(): ReadonlyArray<ThemeDefinition> {
  if (customThemeCache === null) customThemeCache = readStoredThemeLibrary().themes;
  return customThemeCache;
}

function notifyCustomThemes(): void {
  customThemeCache = null;
  for (const listener of customThemeListeners) listener();
}

export function invalidateCustomThemes(): void {
  notifyCustomThemes();
}

export function getCustomThemes(): ReadonlyArray<ThemeDefinition> {
  return getCustomThemeLibrary();
}

export function subscribeToCustomThemes(listener: () => void): () => void {
  customThemeListeners.add(listener);
  if (typeof window === "undefined") return () => customThemeListeners.delete(listener);

  const handleStorage = (event: StorageEvent) => {
    if (event.key === CUSTOM_THEMES_STORAGE_KEY || event.key === null) notifyCustomThemes();
  };
  window.addEventListener("storage", handleStorage);
  return () => {
    customThemeListeners.delete(listener);
    window.removeEventListener("storage", handleStorage);
  };
}

function writeStoredThemeLibrary(themes: ReadonlyArray<ThemeDefinition>): void {
  if (typeof window === "undefined") return;
  const serialized = themes.map((theme) => canonicalizeThemeDefinition(theme));
  window.localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, JSON.stringify(serialized));
  customThemeCache = serialized;
  for (const listener of customThemeListeners) listener();
}

function canonicalizeThemeDefinition(theme: ThemeDefinition): ThemeDefinition {
  if (!isThemeId(theme.id)) throw new Error("Theme ids may only contain lowercase letters, numbers, and hyphens.");
  if (!isThemeLabel(theme.label)) throw new Error("Theme labels must be 48 characters or fewer.");
  if (!isThemeAppearance(theme.appearance)) throw new Error("Theme appearance must be light or dark.");

  const colors = mergeThemeColors(theme.appearance, theme.colors, true);
  if (!colors) throw new Error("Theme colors must be an object.");

  const variants: Partial<Record<ThemeAppearance, ThemeColors>> = {};
  for (const appearance of ["light", "dark"] as const) {
    if (appearance === theme.appearance || theme.variants?.[appearance] === undefined) continue;
    const variantColors = mergeThemeColors(appearance, theme.variants[appearance], true);
    if (!variantColors) throw new Error(`The ${appearance} theme variant is invalid.`);
    variants[appearance] = variantColors;
  }

  return {
    id: theme.id,
    label: theme.label.trim(),
    appearance: theme.appearance,
    colors,
    ...(Object.keys(variants).length > 0 ? { variants } : {}),
    ...(theme.collection ? { collection: parseThemeCollection(theme.collection) } : {}),
    ...(theme.sidebarArtwork ? { sidebarArtwork: true } : {}),
    ...(theme.managed ? { managed: true } : {}),
  };
}

export function parseThemeFile(value: unknown): ThemeDefinition {
  if (!isRecord(value)) throw new Error("Theme files must contain a JSON object.");
  if (value.version !== THEME_FILE_VERSION) {
    throw new Error(`This theme file uses an unsupported version. Expected ${THEME_FILE_VERSION}.`);
  }

  const name = value.name;
  const appearance = value.appearance;
  if (!isThemeLabel(name)) throw new Error("Theme files need a name of 48 characters or fewer.");
  if (!isThemeAppearance(appearance)) {
    throw new Error('Theme files need an appearance of "light" or "dark".');
  }

  const id = value.id === undefined ? themeIdFromName(name) : value.id;
  if (!isThemeId(id)) {
    throw new Error("Theme ids may only contain lowercase letters, numbers, and hyphens.");
  }
  if (RESERVED_THEME_IDS.has(id) || BUILT_IN_THEMES.some((theme) => theme.id === id)) {
    throw new Error(`The theme id "${id}" is reserved.`);
  }

  const colors = mergeThemeColors(appearance, value.colors, true);
  if (!colors) throw new Error("Theme files need a colors object.");

  const variants: Partial<Record<ThemeAppearance, ThemeColors>> = {};
  if (value.variants !== undefined) {
    if (!isRecord(value.variants)) throw new Error("Theme variants must be an object.");
    for (const variantAppearance of ["light", "dark"] as const) {
      if (value.variants[variantAppearance] === undefined) continue;
      if (variantAppearance === appearance) {
        throw new Error(`Theme variants must not repeat the base appearance "${appearance}".`);
      }
      const variantColors = mergeThemeColors(variantAppearance, value.variants[variantAppearance], true);
      if (!variantColors) throw new Error(`The ${variantAppearance} theme variant is invalid.`);
      variants[variantAppearance] = variantColors;
    }
  }

  const collection = value.collection === undefined ? undefined : parseThemeCollection(value.collection);
  if (value.collection !== undefined && !collection) {
    throw new Error("Theme collections need a valid id and label.");
  }

  return {
    id,
    label: name.trim(),
    appearance,
    colors,
    ...(Object.keys(variants).length > 0 ? { variants } : {}),
    ...(collection ? { collection } : {}),
    ...(value.managed === true ? { managed: true } : {}),
  };
}

export function serializeThemeFile(theme: ThemeDefinition): string {
  const canonical = canonicalizeThemeDefinition(theme);
  const file: ThemeFile = {
    version: THEME_FILE_VERSION,
    id: canonical.id,
    name: canonical.label,
    appearance: canonical.appearance,
    colors: canonical.colors,
    ...(canonical.variants ? { variants: canonical.variants } : {}),
    ...(canonical.collection ? { collection: canonical.collection } : {}),
    ...(canonical.managed ? { managed: true } : {}),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

export function installCustomTheme(theme: ThemeDefinition): ThemeDefinition {
  if (RESERVED_THEME_IDS.has(theme.id) || BUILT_IN_THEMES.some((item) => item.id === theme.id)) {
    throw new Error(`The theme id "${theme.id}" is reserved.`);
  }
  const canonical = canonicalizeThemeDefinition(theme);
  const current = getCustomThemeLibrary();
  if (current.some((item) => item.id === canonical.id)) {
    throw new Error(`A theme named "${canonical.label}" is already installed.`);
  }
  writeStoredThemeLibrary([...current, canonical]);
  return canonical;
}

export function updateCustomTheme(theme: ThemeDefinition): ThemeDefinition {
  if (RESERVED_THEME_IDS.has(theme.id) || BUILT_IN_THEMES.some((item) => item.id === theme.id)) {
    throw new Error(`The theme id "${theme.id}" is reserved.`);
  }
  const canonical = canonicalizeThemeDefinition(theme);
  const current = getCustomThemeLibrary();
  const index = current.findIndex((item) => item.id === canonical.id);
  if (index === -1) throw new Error(`The theme "${canonical.label}" is not installed.`);
  const next = [...current];
  next[index] = canonical;
  writeStoredThemeLibrary(next);
  return canonical;
}

export function removeCustomTheme(themeId: string): void {
  const current = getCustomThemeLibrary();
  writeStoredThemeLibrary(current.filter((theme) => theme.id !== themeId));
}

export function getThemeDefinition(themeId: string): ThemeDefinition | null {
  return BUILT_IN_THEMES.find((theme) => theme.id === themeId) ??
    getCustomThemeLibrary().find((theme) => theme.id === themeId) ??
    null;
}

export function getThemeColorsForMode(
  theme: ThemeDefinition,
  appearance: ThemeAppearance,
): ThemeColors | null {
  return appearance === theme.appearance ? theme.colors : theme.variants?.[appearance] ?? null;
}

export function getThemeModes(theme: ThemeDefinition): ReadonlyArray<ThemeAppearance> {
  return (["light", "dark"] as const).filter((appearance) => getThemeColorsForMode(theme, appearance));
}

export function isKnownThemePreference(themeId: string): boolean {
  return getThemeDefinition(themeId) !== null;
}

export function parseThemeHalves(raw: string | null): ThemeHalves | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return null;
    const halves: Partial<Record<ThemeAppearance, string>> = {};
    for (const appearance of ["light", "dark"] as const) {
      const themeId = value[appearance];
      if (typeof themeId !== "string") continue;
      const definition = getThemeDefinition(themeId);
      if (definition && getThemeColorsForMode(definition, appearance)) halves[appearance] = definition.id;
    }
    return halves.light || halves.dark ? halves : null;
  } catch {
    return null;
  }
}

export function resolveThemeHalf(
  themeId: string,
  halves: ThemeHalves | null,
  appearance: ThemeAppearance,
): string {
  const half = halves?.[appearance];
  if (half) {
    const definition = getThemeDefinition(half);
    if (definition && getThemeColorsForMode(definition, appearance)) return half;
  }
  return themeId;
}

export function resolveThemeAppearance(
  themeId: string,
  systemDark: boolean,
  appearanceMode: ThemePreferenceMode = "system",
  halves: ThemeHalves | null = null,
): ThemeAppearance {
  const systemAppearance: ThemeAppearance = systemDark ? "dark" : "light";
  const requested = appearanceMode === "system" ? systemAppearance : appearanceMode;
  const halfThemeId = resolveThemeHalf(themeId, halves, requested);
  const definition = getThemeDefinition(halfThemeId);
  if (!definition) return "light";
  return getThemeColorsForMode(definition, requested) ? requested : definition.appearance;
}

export function resolveDesktopTheme(
  themeId: string,
  appearanceMode: ThemePreferenceMode = "system",
  halves: ThemeHalves | null = null,
): ThemePreferenceMode {
  if (appearanceMode !== "system") return resolveThemeAppearance(themeId, false, appearanceMode, halves);
  const definition = getThemeDefinition(themeId);
  const hasLight = Boolean(halves?.light || definition && getThemeColorsForMode(definition, "light"));
  const hasDark = Boolean(halves?.dark || definition && getThemeColorsForMode(definition, "dark"));
  return hasLight && hasDark ? "system" : definition?.appearance ?? "light";
}

function removeThemeVariables(root: HTMLElement): void {
  for (const variable of Object.values(APP_THEME_VARIABLES)) root.style.removeProperty(variable);
  for (const variable of [
    "--app-theme-accent-hover",
    "--app-theme-border-subtle",
    "--app-theme-control-hover",
    "--app-theme-dialog-shadow",
    "--app-theme-error-border",
    "--app-theme-focus-ring",
    "--app-theme-overlay",
    "--app-theme-success",
    "--app-theme-success-surface",
    "--app-theme-text-placeholder",
    "--app-theme-text-secondary",
    "--app-theme-text-subtle",
  ]) {
    root.style.removeProperty(variable);
  }
}

/**
 * GitGui has a few older component aliases in addition to T3's canonical
 * roles. Keep those aliases derived from the active palette so custom themes
 * recolor the existing shell consistently during the migration.
 */
function applyCompatibilityThemeVariables(root: HTMLElement, colors: ThemeColors): void {
  root.style.setProperty("--app-theme-accent-hover", colors.messageActionHover);
  root.style.setProperty("--app-theme-border-subtle", colors.border);
  root.style.setProperty("--app-theme-control-hover", colors.toolbarControlHover);
  root.style.setProperty(
    "--app-theme-dialog-shadow",
    `0 24px 80px color-mix(in srgb, ${colors.text} 24%, transparent)`,
  );
  root.style.setProperty(
    "--app-theme-error-border",
    `color-mix(in srgb, ${colors.error} 35%, transparent)`,
  );
  root.style.setProperty(
    "--app-theme-focus-ring",
    `color-mix(in srgb, ${colors.focus} 25%, transparent)`,
  );
  root.style.setProperty(
    "--app-theme-overlay",
    `color-mix(in srgb, ${colors.text} 35%, transparent)`,
  );
  root.style.setProperty("--app-theme-success", colors.update);
  root.style.setProperty("--app-theme-success-surface", colors.updateSurface);
  root.style.setProperty("--app-theme-text-placeholder", colors.placeholder);
  root.style.setProperty("--app-theme-text-secondary", colors.secondaryForeground);
  root.style.setProperty("--app-theme-text-subtle", colors.secondaryLabel);
}

export function applyThemeColorPreview(colors: ThemeColors, appearance: ThemeAppearance): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.themeId = THEME_PREVIEW_ID;
  root.dataset.themeAppearance = appearance;
  root.classList.toggle("dark", appearance === "dark");
  root.style.colorScheme = appearance;
  for (const [role, value] of Object.entries(colors) as Array<[ThemeColorRole, string]>) {
    const normalized = toCanonicalThemeColor(value);
    if (normalized) root.style.setProperty(APP_THEME_VARIABLES[role], normalized);
  }
  applyCompatibilityThemeVariables(root, colors);
}

export function applyThemePalette(themeId: string, appearance?: ThemeAppearance): ThemeAppearance | null {
  if (typeof document === "undefined") return null;
  const root = document.documentElement;
  const definition = getThemeDefinition(themeId);
  if (!definition) {
    delete root.dataset.themeId;
    delete root.dataset.themeAppearance;
    removeThemeVariables(root);
    return null;
  }

  const resolvedAppearance = appearance ?? definition.appearance;
  const colors = getThemeColorsForMode(definition, resolvedAppearance) ?? definition.colors;
  root.dataset.themeId = definition.id;
  root.dataset.themeAppearance = resolvedAppearance;
  root.classList.toggle("dark", resolvedAppearance === "dark");
  root.style.colorScheme = resolvedAppearance;
  for (const [role, value] of Object.entries(colors) as Array<[ThemeColorRole, string]>) {
    root.style.setProperty(APP_THEME_VARIABLES[role], value);
  }
  applyCompatibilityThemeVariables(root, colors);
  return resolvedAppearance;
}
