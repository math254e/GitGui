import {
  applyThemePalette,
  CUSTOM_THEMES_STORAGE_KEY,
  DEFAULT_THEME_ID,
  getThemeDefinition,
  getThemeColorsForMode,
  invalidateCustomThemes,
  isKnownThemePreference,
  isThemePreferenceMode,
  parseThemeHalves,
  resolveDesktopTheme,
  resolveThemeAppearance,
  resolveThemeHalf,
} from "./themePalette";
import {
  THEME_APPEARANCE_MODE_STORAGE_KEY,
  THEME_HALVES_STORAGE_KEY,
  THEME_STORAGE_KEY,
  type ThemeAppearance,
  type ThemeHalves,
  type ThemeListener,
  type ThemePreferenceMode,
  type ThemeSnapshot,
  type ThemeStore,
} from "./types";

const MEDIA_QUERY = "(prefers-color-scheme: dark)";
const THEME_COLOR_META_NAME = "theme-color";

const DEFAULT_SNAPSHOT: ThemeSnapshot = {
  theme: DEFAULT_THEME_ID,
  systemDark: false,
  appearanceMode: "system",
  followSystem: true,
  resolvedAppearance: "light",
  resolvedTheme: "light",
  themeHalves: null,
};

let listeners = new Set<ThemeListener>();
let lastSnapshot: ThemeSnapshot | null = null;
let windowListenersInstalled = false;

function systemIsDark(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(MEDIA_QUERY).matches;
}

function readThemePreference(): string {
  if (typeof window === "undefined") return DEFAULT_THEME_ID;
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "ember" && isKnownThemePreference("gitkraken")) {
      window.localStorage.setItem(THEME_STORAGE_KEY, "gitkraken");
      return "gitkraken";
    }
    return stored && isKnownThemePreference(stored) ? stored : DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

function readAppearanceModePreference(): ThemePreferenceMode {
  if (typeof window === "undefined") return "system";
  try {
    const stored = window.localStorage.getItem(THEME_APPEARANCE_MODE_STORAGE_KEY);
    return isThemePreferenceMode(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

function readThemeHalves(): ThemeHalves | null {
  if (typeof window === "undefined") return null;
  try {
    return parseThemeHalves(window.localStorage.getItem(THEME_HALVES_STORAGE_KEY));
  } catch {
    return null;
  }
}

function getSnapshot(): ThemeSnapshot {
  if (typeof window === "undefined") return DEFAULT_SNAPSHOT;

  const theme = readThemePreference();
  const appearanceMode = readAppearanceModePreference();
  const followSystem = appearanceMode === "system";
  const systemDark = followSystem ? systemIsDark() : false;
  const themeHalves = readThemeHalves();
  const resolvedAppearance = resolveThemeAppearance(theme, systemDark, appearanceMode, themeHalves);

  if (
    lastSnapshot?.theme === theme &&
    lastSnapshot.appearanceMode === appearanceMode &&
    lastSnapshot.systemDark === systemDark &&
    JSON.stringify(lastSnapshot.themeHalves) === JSON.stringify(themeHalves) &&
    lastSnapshot.resolvedAppearance === resolvedAppearance
  ) {
    return lastSnapshot;
  }

  lastSnapshot = {
    theme,
    systemDark,
    appearanceMode,
    followSystem,
    resolvedAppearance,
    resolvedTheme: resolvedAppearance,
    themeHalves,
  };
  return lastSnapshot;
}

function notify(): void {
  const snapshot = getSnapshot();
  for (const listener of listeners) listener(snapshot);
}

function syncBrowserChromeTheme(): void {
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return;
  const rootStyles = getComputedStyle(document.documentElement);
  const chrome = rootStyles.getPropertyValue("--app-theme-chrome").trim();
  if (!chrome) return;

  document.documentElement.style.backgroundColor = chrome;
  if (document.body) document.body.style.backgroundColor = chrome;

  const metas = document.querySelectorAll<HTMLMetaElement>(`meta[name="${THEME_COLOR_META_NAME}"]`);
  if (metas.length === 0) {
    const meta = document.createElement("meta");
    meta.name = THEME_COLOR_META_NAME;
    meta.dataset.dynamicThemeColor = "true";
    document.head.append(meta);
    meta.content = chrome;
  } else {
    for (const meta of metas) meta.content = chrome;
  }
}

function applyCurrentTheme(suppressTransitions = false): void {
  if (typeof document === "undefined" || typeof window === "undefined") return;

  const snapshot = getSnapshot();
  const themeId = resolveThemeHalf(snapshot.theme, snapshot.themeHalves, snapshot.resolvedAppearance);
  if (suppressTransitions) document.documentElement.classList.add("no-transitions");
  applyThemePalette(themeId, snapshot.resolvedAppearance);
  syncBrowserChromeTheme();

  if (suppressTransitions) {
    void document.documentElement.offsetHeight;
    const remove = () => document.documentElement.classList.remove("no-transitions");
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(remove);
    else setTimeout(remove, 0);
  }
}

function writePreference(key: string, value: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch (error) {
    console.warn(`[GitGui] Could not persist theme preference ${key}.`, error);
    return false;
  }
}

function handleSystemAppearanceChange(): void {
  if (readAppearanceModePreference() !== "system") return;
  lastSnapshot = null;
  applyCurrentTheme(true);
  notify();
}

function handleStorageChange(event: StorageEvent): void {
  if (
    event.key !== THEME_STORAGE_KEY &&
    event.key !== THEME_APPEARANCE_MODE_STORAGE_KEY &&
    event.key !== THEME_HALVES_STORAGE_KEY &&
    event.key !== CUSTOM_THEMES_STORAGE_KEY &&
    event.key !== null
  ) {
    return;
  }
  invalidateCustomThemes();
  lastSnapshot = null;
  applyCurrentTheme(true);
  notify();
}

function ensureWindowListeners(): void {
  if (typeof window === "undefined" || windowListenersInstalled) return;

  const media = typeof window.matchMedia === "function" ? window.matchMedia(MEDIA_QUERY) : null;
  media?.addEventListener("change", handleSystemAppearanceChange);
  window.addEventListener("storage", handleStorageChange);
  windowListenersInstalled = true;
}

function subscribe(listener: ThemeListener): () => void {
  listeners.add(listener);
  ensureWindowListeners();

  return () => {
    listeners.delete(listener);
  };
}

function setTheme(themeId: string): boolean {
  if (!isKnownThemePreference(themeId) || !writePreference(THEME_STORAGE_KEY, themeId)) return false;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(THEME_HALVES_STORAGE_KEY);
    } catch (error) {
      console.warn("[GitGui] Could not clear theme halves.", error);
    }
  }
  lastSnapshot = null;
  applyCurrentTheme(true);
  notify();
  return true;
}

function setAppearanceMode(mode: ThemePreferenceMode): boolean {
  if (!isThemePreferenceMode(mode) || !writePreference(THEME_APPEARANCE_MODE_STORAGE_KEY, mode)) {
    return false;
  }
  lastSnapshot = null;
  applyCurrentTheme(true);
  notify();
  return true;
}

function setFollowSystem(followSystem: boolean): boolean {
  const current = readAppearanceModePreference();
  return setAppearanceMode(followSystem ? "system" : current === "system" ? "light" : current);
}

function setThemeHalf(appearance: ThemeAppearance, themeId: string | null): boolean {
  if (themeId !== null) {
    const definition = getThemeDefinition(themeId);
    if (!definition || !getThemeColorsForMode(definition, appearance)) return false;
  }

  if (typeof window === "undefined") return false;
  try {
    const current = readThemeHalves() ?? {};
    const next: Partial<Record<ThemeAppearance, string>> = { ...current };
    if (themeId === null) delete next[appearance];
    else next[appearance] = themeId;
    if (next.light || next.dark) {
      window.localStorage.setItem(THEME_HALVES_STORAGE_KEY, JSON.stringify(next));
    } else {
      window.localStorage.removeItem(THEME_HALVES_STORAGE_KEY);
    }
  } catch (error) {
    console.warn("[GitGui] Could not persist theme half.", error);
    return false;
  }

  lastSnapshot = null;
  applyCurrentTheme(true);
  notify();
  return true;
}

function clearThemeHalves(): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.removeItem(THEME_HALVES_STORAGE_KEY);
  } catch (error) {
    console.warn("[GitGui] Could not clear theme halves.", error);
    return false;
  }
  lastSnapshot = null;
  applyCurrentTheme(true);
  notify();
  return true;
}

function refreshTheme(): void {
  lastSnapshot = null;
  applyCurrentTheme(true);
  notify();
}

export const themeStore: ThemeStore = {
  subscribe,
  getSnapshot,
  setTheme,
  setAppearanceMode,
  setFollowSystem,
  setThemeHalf,
  clearThemeHalves,
  refreshTheme,
};

/** Svelte-friendly accessor; the returned object is also usable with `$theme`. */
export function useTheme(): ThemeStore {
  return themeStore;
}

/** Apply the initial preference as soon as this module is loaded in the browser. */
if (typeof window !== "undefined" && typeof document !== "undefined") {
  ensureWindowListeners();
  applyCurrentTheme();
}

export function getThemeDesktopPreference(): ThemePreferenceMode {
  const snapshot = getSnapshot();
  return resolveDesktopTheme(snapshot.theme, snapshot.appearanceMode, snapshot.themeHalves);
}
