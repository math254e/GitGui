// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import ThemeAppearancePanel from "./ThemeAppearancePanel.svelte";
import { DEFAULT_THEME_DEFINITIONS } from "./theme-types";

vi.mock("@lucide/svelte", () => ({ Check: () => {}, Copy: () => {}, Moon: () => {}, Plus: () => {}, Sun: () => {}, Trash2: () => {}, Upload: () => {} }));

let component: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  document.body.replaceChildren();
});

describe("appearance selection", () => {
  it("previews the selected light and dark palettes independently", () => {
    component = mount(ThemeAppearancePanel, { target: document.body, props: {
      selectedThemeId: "t3-code", selectedThemeIds: { light: "ocean", dark: "grove" }, appearanceMode: "system",
    } });
    flushSync();
    const ocean = DEFAULT_THEME_DEFINITIONS.find((theme) => theme.id === "ocean")!;
    const grove = DEFAULT_THEME_DEFINITIONS.find((theme) => theme.id === "grove")!;
    const previews = document.querySelectorAll<HTMLElement>('[data-appearance="system"] .workspace-preview');
    expect(previews[0].style.getPropertyValue("--preview-canvas").trim()).toBe(ocean.colors.light.canvas);
    expect(previews[1].style.getPropertyValue("--preview-canvas").trim()).toBe(grove.colors.dark.canvas);
    expect(document.querySelector('[aria-label="Use Ocean Light theme"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector('[aria-label="Use Grove Dark theme"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector('[aria-label="Use T3 Code theme"]')?.getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps variant, whole-theme, duplicate and appearance actions separate", () => {
    const onThemeSelect = vi.fn(), onDuplicateTheme = vi.fn(), onAppearanceModeChange = vi.fn();
    component = mount(ThemeAppearancePanel, { target: document.body, props: {
      onThemeSelect, onDuplicateTheme, onAppearanceModeChange,
    } });
    flushSync();
    document.querySelector<HTMLButtonElement>('[aria-label="Use Ocean Light theme"]')!.click();
    expect(onThemeSelect).toHaveBeenLastCalledWith("ocean", "light");
    document.querySelector<HTMLButtonElement>('[aria-label="Use Grove Dark theme"]')!.click();
    expect(onThemeSelect).toHaveBeenLastCalledWith("grove", "dark");
    document.querySelector<HTMLButtonElement>('[aria-label="Use Iris theme"]')!.click();
    expect(onThemeSelect).toHaveBeenLastCalledWith("iris", "system");
    document.querySelector<HTMLButtonElement>('[aria-label="Duplicate Iris theme"]')!.click();
    expect(onDuplicateTheme).toHaveBeenCalledExactlyOnceWith("iris");
    expect(onThemeSelect).toHaveBeenCalledTimes(3);
    document.querySelector<HTMLButtonElement>('[aria-label="Dark: Always use dark mode"]')!.click();
    expect(onAppearanceModeChange).toHaveBeenCalledExactlyOnceWith("dark");
    expect(onThemeSelect).toHaveBeenCalledTimes(3);
  });
});
