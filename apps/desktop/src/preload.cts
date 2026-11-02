import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge, DesktopConnectionRegistration, DesktopCredential, DesktopSshTarget,
  DesktopUpdateStatus } from "@gitgui/contracts/desktop" with { "resolution-mode": "import" };
const bridge: DesktopBridge = {
  getPrimaryEnvironment: () => ipcRenderer.invoke("desktop:primary:get"),
  restartPrimaryEnvironment: () => ipcRenderer.invoke("desktop:primary:restart"),
  listConnectionRegistrations: () => ipcRenderer.invoke("desktop:registrations:list"),
  saveConnectionRegistration: (registration: DesktopConnectionRegistration) => ipcRenderer.invoke("desktop:registrations:save", registration),
  removeConnectionRegistration: (environmentId: string) => ipcRenderer.invoke("desktop:registrations:remove", environmentId),
  getCredential: (environmentId: string) => ipcRenderer.invoke("desktop:credentials:get", environmentId),
  setCredential: (environmentId: string, credential: DesktopCredential) => ipcRenderer.invoke("desktop:credentials:set", environmentId, credential),
  removeCredential: (environmentId: string) => ipcRenderer.invoke("desktop:credentials:remove", environmentId),
  pickFolder: () => ipcRenderer.invoke("desktop:dialog:folder"),
  discoverSshHosts: () => ipcRenderer.invoke("desktop:ssh:discover"),
  ensureSshConnection: (target: DesktopSshTarget) => ipcRenderer.invoke("desktop:ssh:ensure", target),
  disconnectSshConnection: (target: DesktopSshTarget) => ipcRenderer.invoke("desktop:ssh:disconnect", target),
  getUpdateStatus: () => ipcRenderer.invoke("desktop:updates:status"),
  checkForUpdates: () => ipcRenderer.invoke("desktop:updates:check"),
  downloadUpdate: () => ipcRenderer.invoke("desktop:updates:download"),
  installUpdate: (expectedVersion?: string) => ipcRenderer.invoke("desktop:updates:install", expectedVersion),
  onUpdateStatus(listener: (status: DesktopUpdateStatus) => void) {
    const callback = (_event: Electron.IpcRendererEvent, status: DesktopUpdateStatus) => listener(status);
    ipcRenderer.on("desktop:updates:status", callback);
    return () => ipcRenderer.removeListener("desktop:updates:status", callback);
  },
  onDeepLink(listener: (url: string) => void) {
    const callback = (_event: Electron.IpcRendererEvent, url: string) => listener(url);
    ipcRenderer.on("desktop:deep-link", callback);
    return () => ipcRenderer.removeListener("desktop:deep-link", callback);
  },
  onApplicationWakeup(listener: () => void) {
    const callback = () => listener();
    ipcRenderer.on("desktop:application-wakeup", callback);
    return () => ipcRenderer.removeListener("desktop:application-wakeup", callback);
  },
};

contextBridge.exposeInMainWorld("desktopBridge", Object.freeze(bridge));
