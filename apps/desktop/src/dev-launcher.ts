import type { App } from "electron";

/** Parent-only development control; never a renderer capability or Git RPC. */
export function registerDevelopmentLauncher(
  app: Pick<App, "isPackaged">,
  requestQuit: () => void,
  parent: Pick<NodeJS.Process, "on" | "off" | "send"> = process,
  enabled = process.env.GITGUI_DESKTOP_DEV_LAUNCHER === "1",
): () => void {
  if (app.isPackaged || !enabled || typeof parent.send !== "function") return () => {};
  const message = (value: unknown) => { if (value === "gitgui:dev:quit") requestQuit(); };
  const disconnected = () => requestQuit();
  parent.on("message", message);
  parent.on("disconnect", disconnected);
  return () => {
    parent.off("message", message);
    parent.off("disconnect", disconnected);
  };
}
