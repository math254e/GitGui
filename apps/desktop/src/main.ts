import { join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  autoUpdater as nativeAutoUpdater,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  type IpcMainInvokeEvent,
} from "electron";
import type {
  DesktopConnectionRegistration,
  DesktopCredential,
  DesktopSshRequest,
  DesktopSshTarget,
  DesktopUpdateStatus,
} from "@gitgui/contracts/desktop";
import { DesktopSshEnvironment } from "./ssh/DesktopSshEnvironment.js";
import { BackendManager } from "./backend-manager.js";
import { DesktopStateStore } from "./state-store.js";
import { extractDeepLink, normalizeDeepLink } from "./lifecycle.js";
import { registerDevelopmentLauncher } from "./dev-launcher.js";
import { DesktopUpdates } from "./updates/desktop-updates.js";
import { packagedUpdateEngine, updateDisabledReason } from "./updates/electron-updater.js";

const DEVELOPMENT_ORIGIN = "http://127.0.0.1:1420";
const APPLICATION_ORIGIN = "gitgui://app";

protocol.registerSchemesAsPrivileged([{
  scheme: "gitgui",
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
}]);

let mainWindow: BrowserWindow | null = null;
let backend: BackendManager;
let stateStore: DesktopStateStore;
let ssh: DesktopSshEnvironment;
let quitting = false;
let pendingDeepLink = extractDeepLink(process.argv);
let updates: DesktopUpdates;
let updateQuitReady = false;
let ignoreUpdaterQuit = false;

// T3 DesktopClerk interrupts bootstrap in a secondary instance: app.quit() is
// asynchronous, so it cannot by itself prevent whenReady/window initialization.
if (app.requestSingleInstanceLock()) {
  registerDesktopLifecycle();
} else {
  console.info("[gitgui] GitGui is already running. Reusing the existing desktop instance.");
  app.quit();
}

function registerDesktopLifecycle(): void {
  let quitRequested = false;
  const requestQuit = () => { quitRequested = true; if (!quitting) app.quit(); };
  const releaseLauncher = registerDevelopmentLauncher(app, requestQuit);
  // Like T3 DesktopLifecycle, terminal signals enter ordinary desktop cleanup.
  // Windows terminal delivery is handled by the launcher through inherited IPC.
  const signals = process.platform === "win32" ? [] : ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, requestQuit);
  app.once("will-quit", () => {
    releaseLauncher();
    for (const signal of signals) process.off(signal, requestQuit);
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    queueDeepLink(url);
  });

  void app.whenReady().then(async () => {
    if (quitting || quitRequested) return;
    backend = new BackendManager();
    stateStore = new DesktopStateStore(join(app.getPath("userData"), "desktop-state.json"));
    ssh = new DesktopSshEnvironment({
      stateDirectory: join(app.getPath("userData"), "ssh"),
      getParent: () => mainWindow,
    });
    initializeUpdates();
    registerApplicationProtocol();
    registerIpc();
    await createMainWindow();
    if (quitting || quitRequested) return;
    registerDesktopProtocol();
    updates.start();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) void createMainWindow().catch(handleStartupFailure);
    });
  }).catch(handleStartupFailure);

  app.on("second-instance", (_event, commandLine) => {
    queueDeepLink(extractDeepLink(commandLine));
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on("browser-window-focus", (_event, window) => {
    if (window === mainWindow) window.webContents.send("desktop:application-wakeup");
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", (event) => {
    if (ignoreUpdaterQuit) { ignoreUpdaterQuit = false; event.preventDefault(); return; }
    if (updates?.isInstallActive && !updateQuitReady) { event.preventDefault(); return; }
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    updates?.dispose();
    void Promise.allSettled([backend?.shutdown(), ssh?.dispose()]).finally(() => app.quit());
  });

  nativeAutoUpdater.on("before-quit-for-update", () => {
    // electron-updater can schedule app.quit before an asynchronous install error.
    // A failed attempt must not later turn its scheduled quit into a normal quit.
    ignoreUpdaterQuit = !updateQuitReady || !updates?.isInstallActive;
  });

  app.on("will-quit", () => updates?.dispose());
}

function handleStartupFailure(error: unknown): void {
  if (quitting) return;
  console.error("[gitgui]", { component: "desktop-startup", errorTag: error instanceof Error ? error.name : "UnknownError" });
  try {
    dialog.showErrorBox("GitGui failed to start", app.isPackaged
      ? "GitGui could not open its application window. Close GitGui and try again."
      : `GitGui could not open its development window. Check that the frontend is running at ${DEVELOPMENT_ORIGIN}.`);
  } catch {
    // A failed native dialog must not prevent the normal owned-resource shutdown.
  }
  app.quit();
}

async function createMainWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#111318",
    webPreferences: {
      preload: join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;
  const senderId = window.webContents.id;
  window.webContents.once("destroyed", () => { void ssh.releaseSender(senderId); });
  window.webContents.on("render-process-gone", () => { void ssh.releaseSender(senderId); });
  window.once("ready-to-show", () => window.show());
  window.webContents.once("did-finish-load", () => {
    if (pendingDeepLink) {
      window.webContents.send("desktop:deep-link", pendingDeepLink);
      pendingDeepLink = null;
    }
    window.webContents.send("desktop:updates:status", updates.status);
  });
  window.on("closed", () => { if (mainWindow === window) mainWindow = null; });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void import("electron").then(({ shell }) => shell.openExternal(url));
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedRendererUrl(url)) event.preventDefault();
  });
  // The application origin is the root of the scheme. The path belongs to
  // the client router, and the protocol handler serves the app shell for
  // every path that is not a static asset.
  await window.loadURL(app.isPackaged ? `${APPLICATION_ORIGIN}/` : DEVELOPMENT_ORIGIN);
}

function registerApplicationProtocol(): void {
  protocol.handle("gitgui", (request) => {
    const requestUrl = new URL(request.url);
    const webRoot = app.isPackaged
      ? join(process.resourcesPath, "web")
      : resolve(app.getAppPath(), "..", "web", "build");
    const requestedPath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "") || "index.html";
    let target = resolve(webRoot, requestedPath);
    if (!target.startsWith(resolve(webRoot) + normalize("/")) && target !== resolve(webRoot, "index.html")) {
      return new Response("Forbidden", { status: 403 });
    }
    if (!/\.[A-Za-z0-9]+$/.test(target)) target = resolve(webRoot, "index.html");
    return net.fetch(pathToFileURL(target).toString());
  });
}

function registerIpc(): void {
  ipcMain.handle("desktop:primary:get", trusted((_event) => backend.getConnection()));
  ipcMain.handle("desktop:primary:restart", trusted((_event) => backend.restart()));
  ipcMain.handle("desktop:registrations:list", trusted(() => stateStore.listRegistrations()));
  ipcMain.handle("desktop:registrations:save", trusted((_event, value: DesktopConnectionRegistration, credential?: DesktopCredential) => stateStore.saveRegistration(value, credential)));
  ipcMain.handle("desktop:registrations:remove", trusted((_event, id: string) => stateStore.removeRegistration(id)));
  ipcMain.handle("desktop:credentials:get", trusted((_event, id: string) => stateStore.getCredential(id)));
  ipcMain.handle("desktop:credentials:set", trusted((_event, id: string, credential: DesktopCredential) => stateStore.setCredential(id, credential)));
  ipcMain.handle("desktop:credentials:remove", trusted((_event, id: string) => stateStore.removeCredential(id)));
  ipcMain.handle("desktop:dialog:folder", trusted(async () => {
    const options = { properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory"> };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  }));
  ipcMain.handle("desktop:ssh:discover", trusted(() => ssh.discoverHosts()));
  ipcMain.handle("desktop:ssh:ensure", trusted((event, target: DesktopSshTarget, request?: DesktopSshRequest) => ssh.ensureEnvironment(event.sender.id, target, request)));
  ipcMain.handle("desktop:ssh:pairing", trusted((event, id: string, expectedId: string) => ssh.issuePairingCredential(event.sender.id, id, expectedId)));
  ipcMain.handle("desktop:ssh:claim", trusted((event, id: string, expectedId: string) => ssh.claimConnection(event.sender.id, id, expectedId)));
  ipcMain.handle("desktop:ssh:cancel", trusted((event, id: string) => ssh.cancelConnection(event.sender.id, id)));
  ipcMain.handle("desktop:ssh:disconnect", trusted((_event, target: DesktopSshTarget) => ssh.disconnectEnvironment(target)));
  ipcMain.handle("desktop:updates:status", trusted(() => updates.status));
  ipcMain.handle("desktop:updates:check", trusted(() => updates.check()));
  ipcMain.handle("desktop:updates:download", trusted(() => updates.download()));
  ipcMain.handle("desktop:updates:install", trusted((_event, expectedVersion?: string) => {
    if (expectedVersion !== undefined && (typeof expectedVersion !== "string" || expectedVersion.length > 64)) {
      throw new Error("Invalid expected update version");
    }
    return updates.install(expectedVersion);
  }));
}

function registerDesktopProtocol(): void {
  if (!app.isPackaged) return;
  app.setAsDefaultProtocolClient("gitgui");
}

function initializeUpdates(): void {
  const { engine, hasFeed } = packagedUpdateEngine(process.resourcesPath);
  updates = new DesktopUpdates(engine, {
    async stopForInstall() {
      // T3 sets quitting before install cleanup. Close SSH admission first and
      // drain setup even if the local backend refuses update preparation.
      const closingSsh = ssh.close();
      try {
        await backend.shutdownForUpdate();
      } finally {
        await closingSsh;
      }
      quitting = true;
      updateQuitReady = true;
    },
    async recoverFromInstall() {
      updateQuitReady = false;
      quitting = false;
      await backend.recoverAfterUpdate();
      await ssh.reopen();
      mainWindow?.webContents.send("desktop:application-wakeup");
    },
  }, {
    currentVersion: app.getVersion(),
    releaseBaseUrl: "https://github.com/math254e/GitGui/releases",
    disabledReason: updateDisabledReason(app.isPackaged, process.platform, process.env.APPIMAGE,
      hasFeed, process.env.GITGUI_DISABLE_AUTO_UPDATE === "1"),
  });
  updates.subscribe((status: DesktopUpdateStatus) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("desktop:updates:status", status);
  });
}

function queueDeepLink(value: string | null): void {
  const normalized = normalizeDeepLink(value);
  if (!normalized) return;
  pendingDeepLink = normalized;
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send("desktop:deep-link", normalized);
    pendingDeepLink = null;
  }
}

function trusted<T extends unknown[], R>(
  handler: (event: IpcMainInvokeEvent, ...args: T) => R,
): (event: IpcMainInvokeEvent, ...args: T) => R {
  return (event, ...args) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || !event.senderFrame || event.senderFrame !== event.sender.mainFrame || !isAllowedRendererUrl(event.senderFrame.url)) throw new Error("Rejected IPC from an untrusted renderer");
    return handler(event, ...args);
  };
}

function isAllowedRendererUrl(value: string): boolean {
  return value.startsWith(`${APPLICATION_ORIGIN}/`) || value === DEVELOPMENT_ORIGIN || value.startsWith(`${DEVELOPMENT_ORIGIN}/`);
}
