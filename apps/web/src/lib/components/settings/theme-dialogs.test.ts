// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import ThemeEditorPanel from "./ThemeEditorPanel.svelte";
import ThemeImportDialog from "./ThemeImportDialog.svelte";
import ThemeDeleteDialog from "./ThemeDeleteDialog.svelte";
import { GROVE_THEME, parseThemeFile, serializeThemeFile } from "../../theme/themePalette";

vi.mock("@lucide/svelte", () => ({ AlertCircle: () => {}, Check: () => {}, Moon: () => {}, Palette: () => {}, Sun: () => {}, X: () => {}, ClipboardPaste: () => {}, FileJson: () => {}, Upload: () => {}, Trash2: () => {} }));

let component: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (component) await unmount(component); component = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); });

describe("theme dialog interactions", () => {
  it("does not silently save the previous palette when a color field is invalid", () => {
    const onSave = vi.fn();
    component = mount(ThemeEditorPanel, { target: document.body, props: { open: true, onSave } }); flushSync();
    const canvas = document.querySelector<HTMLInputElement>('[aria-label="light canvas CSS color"]')!;
    canvas.value = "#ffffff;";
    canvas.dispatchEvent(new Event("input", { bubbles: true })); flushSync();
    const save = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Create theme")!;
    save.click(); flushSync();
    expect(onSave).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Enter a valid CSS color");
  });
  it("keeps authored OKLCH colors when an existing theme is saved without color edits", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const theme = { ...GROVE_THEME, id: "personal-grove", label: "Personal Grove" };
    const onSave = vi.fn();
    component = mount(ThemeEditorPanel, { target: document.body, props: { open: true, theme, onSave } }); flushSync();
    expect(document.querySelector("dialog")!.open).toBe(true);
    expect(document.querySelector<HTMLInputElement>('[aria-label="light canvas CSS color"]')!.value).toBe(theme.colors.canvas);
    const save = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save changes")!;
    save.click(); flushSync();
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave.mock.calls[0][0].colors).toEqual(theme.colors);
    expect(onSave.mock.calls[0][0].variants).toEqual(theme.variants);
  });

  it("validates imports and preserves the palette through the modal confirmation", () => {
    const onImported = vi.fn(), onClose = vi.fn();
    component = mount(ThemeImportDialog, { target: document.body, props: { open: true, onImported, onClose } }); flushSync();
    const textarea = document.querySelector("textarea")!;
    const theme = parseThemeFile({ version: 1, id: "imported-grove", name: "Imported Grove", appearance: "light", colors: GROVE_THEME.colors, variants: GROVE_THEME.variants });
    textarea.value = serializeThemeFile(theme);
    textarea.dispatchEvent(new Event("input", { bubbles: true })); flushSync();
    const submit = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Import theme")!;
    expect(submit.disabled).toBe(false);
    submit.click();
    expect(onImported).toHaveBeenCalledExactlyOnceWith(theme);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("treats Escape as cancellation without deleting a theme", async () => {
    const onCancel = vi.fn(), onConfirm = vi.fn();
    component = mount(ThemeDeleteDialog, { target: document.body, props: { open: true, theme: GROVE_THEME, onCancel, onConfirm } }); flushSync();
    await Promise.resolve();
    expect(document.activeElement?.textContent?.trim()).toBe("Cancel");
    const event = new Event("cancel", { cancelable: true });
    document.querySelector("dialog")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
