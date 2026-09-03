import { join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  type IpcMainInvokeEvent,
} from "electron";
import { autoUpdater } from "electron-updater";
import type {
  DesktopConnectionRegistration,
  DesktopCredential,
  DesktopSshTarget,
  DesktopUpdateStatus,
} from "@gitgui/contracts/desktop";
import { SshEnvironmentManager } from "@gitgui/ssh";
import { BackendManager } from "./backend-manager.js";
import { DesktopStateStore } from "./state-store.js";
import { extractDeepLink, normalizeDeepLink, normalizeUpdateFeedUrl } from "./lifecycle.js";

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

if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow: BrowserWindow | null = null;
let backend: BackendManager;
let stateStore: DesktopStateStore;
let ssh: SshEnvironmentManager;
let quitting = false;
let pendingDeepLink = extractDeepLink(process.argv);
let updateFeedUrl: string | null = null;
let updateTimer: NodeJS.Timeout | undefined;
let updateStatus: DesktopUpdateStatus = { phase: "disabled", message: "Updates are available in packaged builds." };

app.on("open-url", (event, url) => {
  event.preventDefault();
  queueDeepLink(url);
});

app.whenReady().then(async () => {
  backend = new BackendManager();
  stateStore = new DesktopStateStore(join(app.getPath("userData"), "desktop-state.json"));
  ssh = new SshEnvironmentManager({
    stateDirectory: join(app.getPath("userData"), "ssh"),
    requestPassword: (target, prompt) => promptForSecret(target, prompt),
    requestHostTrust: (target) => promptForHostTrust(target),
  });
  registerApplicationProtocol();
  registerIpc();
  await createMainWindow();
  registerDesktopProtocol();
  initializeUpdates();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createMainWindow();
  });
});

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
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  if (updateTimer) clearInterval(updateTimer);
  void Promise.allSettled([backend?.shutdown(), ssh?.close()]).finally(() => app.quit());
});

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
  window.once("ready-to-show", () => window.show());
  window.webContents.once("did-finish-load", () => {
    if (pendingDeepLink) {
      window.webContents.send("desktop:deep-link", pendingDeepLink);
      pendingDeepLink = null;
    }
    window.webContents.send("desktop:updates:status", updateStatus);
  });
  window.on("closed", () => { if (mainWindow === window) mainWindow = null; });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void import("electron").then(({ shell }) => shell.openExternal(url));
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedRendererUrl(url)) event.preventDefault();
  });
  await window.loadURL(app.isPackaged ? `${APPLICATION_ORIGIN}/index.html` : DEVELOPMENT_ORIGIN);
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
  ipcMain.handle("desktop:registrations:save", trusted((_event, value: DesktopConnectionRegistration) => stateStore.saveRegistration(value)));
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
  ipcMain.handle("desktop:ssh:ensure", trusted((_event, target: DesktopSshTarget) => ssh.ensureEnvironment(target)));
  ipcMain.handle("desktop:ssh:disconnect", trusted((_event, target: DesktopSshTarget) => ssh.disconnectEnvironment(target)));
  ipcMain.handle("desktop:updates:status", trusted(() => updateStatus));
  ipcMain.handle("desktop:updates:check", trusted(() => checkForUpdates()));
  ipcMain.handle("desktop:updates:install", trusted(() => {
    if (updateStatus.phase !== "downloaded") throw new Error("No downloaded GitGui update is ready to install");
    autoUpdater.quitAndInstall();
  }));
}

function registerDesktopProtocol(): void {
  if (!app.isPackaged) return;
  app.setAsDefaultProtocolClient("gitgui");
}

function initializeUpdates(): void {
  if (!app.isPackaged) return;
  updateFeedUrl = normalizeUpdateFeedUrl(process.env.GITGUI_UPDATE_FEED_URL);
  if (!updateFeedUrl) {
    setUpdateStatus({ phase: "disabled", message: "No secure update feed is configured." });
    return;
  }
  autoUpdater.setFeedURL({ provider: "generic", url: updateFeedUrl });
  autoUpdater.on("checking-for-update", () => setUpdateStatus({ phase: "checking" }));
  autoUpdater.on("update-available", () => setUpdateStatus({ phase: "available" }));
  autoUpdater.on("update-not-available", () => setUpdateStatus({ phase: "current", version: app.getVersion() }));
  autoUpdater.on("update-downloaded", (info) => setUpdateStatus({ phase: "downloaded", version: info.version }));
  autoUpdater.on("error", (error) => setUpdateStatus({ phase: "error", message: error.message }));
  setUpdateStatus({ phase: "idle" });
  setTimeout(() => void checkForUpdates(), 15_000).unref();
  updateTimer = setInterval(() => void checkForUpdates(), 6 * 60 * 60 * 1_000);
  updateTimer.unref();
}

async function checkForUpdates(): Promise<DesktopUpdateStatus> {
  if (!updateFeedUrl) return updateStatus;
  setUpdateStatus({ phase: "checking" });
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    setUpdateStatus({ phase: "error", message: error instanceof Error ? error.message : "Update check failed." });
  }
  return updateStatus;
}

function setUpdateStatus(status: DesktopUpdateStatus): void {
  updateStatus = status;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("desktop:updates:status", status);
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
    if (!event.senderFrame || !isAllowedRendererUrl(event.senderFrame.url)) throw new Error("Rejected IPC from an untrusted renderer");
    return handler(event, ...args);
  };
}

function isAllowedRendererUrl(value: string): boolean {
  return value.startsWith(`${APPLICATION_ORIGIN}/`) || value === DEVELOPMENT_ORIGIN || value.startsWith(`${DEVELOPMENT_ORIGIN}/`);
}

async function promptForSecret(target: DesktopSshTarget, prompt: string): Promise<string | null> {
  const parent = mainWindow ?? undefined;
  const window = new BrowserWindow({
    parent,
    modal: Boolean(parent),
    width: 440,
    height: 220,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: `SSH — ${target.host}`,
    webPreferences: {
      preload: join(import.meta.dirname, "prompt-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const escapedPrompt = escapeHtml(prompt);
  const html = `<!doctype html><meta charset="utf-8"><style>body{font:14px system-ui;margin:24px;background:#15171c;color:#f4f4f5}label{display:block;margin-bottom:10px}input{box-sizing:border-box;width:100%;padding:9px;background:#22252c;color:white;border:1px solid #454955;border-radius:5px}.buttons{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}button{padding:7px 14px}</style><form><label for="secret">${escapedPrompt}</label><input id="secret" type="password" autofocus autocomplete="current-password"><div class="buttons"><button type="button" id="cancel">Cancel</button><button type="submit">Connect</button></div></form><script>const api=window.secretPrompt;const input=document.querySelector('#secret');document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();api.submit(input.value)});document.querySelector('#cancel').addEventListener('click',()=>api.cancel());</script>`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener("desktop:secret-prompt:response", onResponse);
      if (!window.isDestroyed()) window.close();
      resolve(value);
    };
    const onResponse = (event: Electron.IpcMainEvent, value: string | null) => {
      if (event.sender !== window.webContents) return;
      finish(typeof value === "string" ? value : null);
    };
    ipcMain.on("desktop:secret-prompt:response", onResponse);
    window.once("closed", () => finish(null));
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => finish(null));
  });
}

async function promptForHostTrust(target: DesktopSshTarget): Promise<boolean> {
  const options = {
    type: "warning" as const,
    title: "Confirm SSH host",
    message: `Trust ${target.host} and add its host key to your OpenSSH known_hosts file?`,
    detail: "Confirm only after verifying the host identity. A changed known host key is never accepted automatically.",
    buttons: ["Cancel", "Trust host"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const result = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  return result.response === 1;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
