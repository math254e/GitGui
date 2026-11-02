import { getContext, setContext } from "svelte";
import type { DesktopBridge } from "@gitgui/contracts/desktop";
import { createDesktopUpdateController, type DesktopUpdateController } from "./controller";

const DESKTOP_UI_CONTEXT = Symbol("gitgui.desktop-ui");

export interface DesktopUiContext {
  readonly updates: DesktopUpdateController | null;
  readonly pickFolder: (() => Promise<string | null>) | null;
}

/** Root-only adapter: desktop capabilities are resolved once and passed down. */
export function provideDesktopUi(bridge: DesktopBridge | null): DesktopUiContext {
  const value: DesktopUiContext = {
    updates: bridge ? createDesktopUpdateController(bridge) : null,
    pickFolder: bridge ? () => bridge.pickFolder() : null,
  };
  setContext(DESKTOP_UI_CONTEXT, value);
  return value;
}

export function getDesktopUi(): DesktopUiContext {
  return getContext<DesktopUiContext>(DESKTOP_UI_CONTEXT) ?? { updates: null, pickFolder: null };
}
