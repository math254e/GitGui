// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { modalDialog } from "./modal-dialog";

afterEach(() => document.body.replaceChildren());

function openDialog() {
  const opener = document.createElement("button");
  const dialog = document.createElement("dialog");
  const input = document.createElement("input");
  input.dataset.dialogInitialFocus = "";
  dialog.append(input);
  document.body.append(opener, dialog);
  opener.focus();
  const action = modalDialog(dialog);
  return { opener, dialog, input, action };
}

describe("conditional modal focus", () => {
  it("restores the opener when a modal is detached before its action is destroyed", async () => {
    const { opener, dialog, input, action } = openDialog();
    await Promise.resolve();
    expect(document.activeElement).toBe(input);
    dialog.remove();
    action.destroy();
    await Promise.resolve();
    expect(document.activeElement).toBe(opener);
  });

  it("does not steal focus from a replacement dialog", async () => {
    const { dialog, action } = openDialog();
    await Promise.resolve();
    dialog.remove();
    action.destroy();
    const replacement = document.createElement("dialog");
    const input = document.createElement("input");
    replacement.append(input);
    document.body.append(replacement);
    replacement.showModal();
    input.focus();
    await Promise.resolve();
    expect(document.activeElement).toBe(input);
  });

  it("does not move focus from another control or back to a removed opener", async () => {
    const { opener, dialog, action } = openDialog();
    await Promise.resolve();
    dialog.remove();
    action.destroy();
    const next = document.createElement("button");
    document.body.append(next);
    next.focus();
    opener.remove();
    await Promise.resolve();
    expect(document.activeElement).toBe(next);
  });
});
