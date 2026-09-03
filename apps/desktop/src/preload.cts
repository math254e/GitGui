import { contextBridge, ipcRenderer } from "electron";

type Registration = { environmentId: string; [key: string]: unknown };
type Credential = { kind: "bootstrap" | "pairing" | "bearer"; token: string; expiresAt?: number };
type SshTarget = { kind: "ssh"; host: string; user?: string; port?: number; identityFile?: string };
type UpdateStatus = { phase: "disabled" | "idle" | "checking" | "available" | "current" | "downloaded" | "error"; version?: string; message?: string };
const bridge = {
  getPrimaryEnvironment: () => ipcRenderer.invoke("desktop:primary:get"),
  restartPrimaryEnvironment: () => ipcRenderer.invoke("desktop:primary:restart"),
  listConnectionRegistrations: () => ipcRenderer.invoke("desktop:registrations:list"),
  saveConnectionRegistration: (registration: Registration) => ipcRenderer.invoke("desktop:registrations:save", registration),
  removeConnectionRegistration: (environmentId: string) => ipcRenderer.invoke("desktop:registrations:remove", environmentId),
  getCredential: (environmentId: string) => ipcRenderer.invoke("desktop:credentials:get", environmentId),
  setCredential: (environmentId: string, credential: Credential) => ipcRenderer.invoke("desktop:credentials:set", environmentId, credential),
  removeCredential: (environmentId: string) => ipcRenderer.invoke("desktop:credentials:remove", environmentId),
  pickFolder: () => ipcRenderer.invoke("desktop:dialog:folder"),
  discoverSshHosts: () => ipcRenderer.invoke("desktop:ssh:discover"),
  ensureSshConnection: (target: SshTarget) => ipcRenderer.invoke("desktop:ssh:ensure", target),
  disconnectSshConnection: (target: SshTarget) => ipcRenderer.invoke("desktop:ssh:disconnect", target),
  getUpdateStatus: () => ipcRenderer.invoke("desktop:updates:status"),
  checkForUpdates: () => ipcRenderer.invoke("desktop:updates:check"),
  installUpdate: () => ipcRenderer.invoke("desktop:updates:install"),
  onUpdateStatus(listener: (status: UpdateStatus) => void) {
    const callback = (_event: Electron.IpcRendererEvent, status: UpdateStatus) => listener(status);
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
