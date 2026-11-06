// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  APP_THEME_VARIABLES, applyThemePalette, BUILT_IN_THEMES, CUSTOM_THEMES_STORAGE_KEY,
  getCustomThemes, getDefaultThemeColors, getThemeDefinition, invalidateCustomThemes,
  parseThemeFile, parseThemeHalves, resolveThemeAppearance, resolveThemeHalf,
  serializeThemeFile, THEME_COLOR_ROLES, T3_CODE_THEME,
} from "./themePalette";
import * as upstream from "./upstreamPalettes";

afterEach(() => {
  localStorage.clear();
  invalidateCustomThemes();
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("class");
});

describe("upstream theme compatibility", () => {
  it("keeps every current upstream palette role and both appearances", () => {
    for (const source of upstream.BUILT_IN_THEMES) {
      const theme = getThemeDefinition(source.id === "ember" ? "t3-ember" : source.id)!;
      expect(theme.colors).toMatchObject(source.colors);
      expect(theme.variants?.dark).toMatchObject(source.variants!.dark!);
      for (const colors of [theme.colors, theme.variants!.dark!]) {
        expect(Object.keys(colors).sort()).toEqual([...THEME_COLOR_ROLES].sort());
      }
    }
  });

  it("keeps the first paint fallback equal to the standard runtime palette", () => {
    const css = readFileSync("src/lib/theme/theme.css", "utf8");
    const blocks = css.match(/\{([^}]+)\}/g)!;
    for (const [index, colors] of [T3_CODE_THEME.colors, T3_CODE_THEME.variants!.dark!].entries()) {
      for (const [role, variable] of Object.entries(APP_THEME_VARIABLES)) {
        expect(blocks[index]).toContain(`${variable}: ${colors[role as keyof typeof colors]};`);
      }
    }
  });

  it("preserves GitKraken and the historical ember half-selection alias", () => {
    expect(getThemeDefinition("gitkraken")?.label).toBe("GitKraken");
    expect(parseThemeHalves('{"light":"ember","dark":"iris"}')).toEqual({ light: "gitkraken", dark: "iris" });
    expect(getThemeDefinition("t3-ember")?.label).toBe("Ember");
  });

  it("does not rewrite custom libraries when reading, applying, or resolving themes", () => {
    const raw = JSON.stringify([
      { id: "personal", label: "Personal", appearance: "light", colors: { canvas: "#eeeedd", accent: "#224466", graphLane3: "#123456" }, variants: { dark: { canvas: "#102030" } }, extraUserMetadata: { keep: true } },
      { id: "future-format", version: 12, keep: "unrecognized entry" },
    ]);
    localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, raw);
    invalidateCustomThemes();
    const personal = getCustomThemes()[0];
    expect(personal.colors.canvas).toBe("#eeeedd");
    expect(personal.colors.graphLane3).toBe("#123456");
    // Unspecified pre-existing roles keep the legacy import defaults.
    expect(personal.colors.sidebar).toBe(getDefaultThemeColors("light").sidebar);
    expect(personal.colors.diffAddition).toBeDefined();
    applyThemePalette("personal", "dark");
    expect(resolveThemeAppearance("personal", true, "system")).toBe("dark");
    const halves = parseThemeHalves('{"light":"personal","dark":"grove"}');
    expect(resolveThemeHalf("personal", halves, "light")).toBe("personal");
    expect(localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY)).toBe(raw);
  });

  it("lets an existing imported id keep its identity when a built-in is added", () => {
    localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, JSON.stringify([
      { id: "t3-ember", label: "My existing Ember", appearance: "dark", colors: { canvas: "#123456" } },
    ]));
    invalidateCustomThemes();
    expect(getThemeDefinition("t3-ember")?.label).toBe("My existing Ember");
    expect(getThemeDefinition("t3-ember")?.colors.canvas).toBe("#123456");
  });

  it("round-trips imported themes with existing and new roles without changing selections", () => {
    const theme = parseThemeFile({
      version: 1, id: "imported", name: "Imported", appearance: "dark",
      colors: { canvas: "#142536", graphLane1: "#cdefab", diffAddition: "#88eeaa", searchMatchBackground: "#554422" },
      variants: { light: { canvas: "#fffdef" } }, collection: { id: "my:collection", label: "My collection" },
    });
    expect(parseThemeFile(JSON.parse(serializeThemeFile(theme)))).toEqual(theme);
    localStorage.setItem("gitgui:theme", "iris");
    localStorage.setItem("gitgui:theme-appearance-mode", "system");
    for (const builtin of BUILT_IN_THEMES) applyThemePalette(builtin.id, "dark");
    expect(localStorage.getItem("gitgui:theme")).toBe("iris");
    expect(localStorage.getItem("gitgui:theme-appearance-mode")).toBe("system");
  });
});
