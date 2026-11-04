import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge, DesktopConnectionRegistration, DesktopCredential, DesktopSshTarget, DesktopSshRequest, DesktopSshResult,
  DesktopUpdateStatus } from "@gitgui/contracts/desktop" with { "resolution-mode": "import" };
const bridge: DesktopBridge = {
  getPrimaryEnvironment: () => ipcRenderer.invoke("desktop:primary:get"),
  restartPrimaryEnvironment: () => ipcRenderer.invoke("desktop:primary:restart"),
  listConnectionRegistrations: () => ipcRenderer.invoke("desktop:registrations:list"),
  saveConnectionRegistration: (registration: DesktopConnectionRegistration, credential?: DesktopCredential) => ipcRenderer.invoke("desktop:registrations:save", registration, credential),
  removeConnectionRegistration: (environmentId: string) => ipcRenderer.invoke("desktop:registrations:remove", environmentId),
  getCredential: (environmentId: string) => ipcRenderer.invoke("desktop:credentials:get", environmentId),
  setCredential: (environmentId: string, credential: DesktopCredential) => ipcRenderer.invoke("desktop:credentials:set", environmentId, credential),
  removeCredential: (environmentId: string) => ipcRenderer.invoke("desktop:credentials:remove", environmentId),
  pickFolder: () => ipcRenderer.invoke("desktop:dialog:folder"),
  discoverSshHosts: () => sshInvoke("desktop:ssh:discover"),
  ensureSshConnection: (target: DesktopSshTarget, request?: DesktopSshRequest) => sshInvoke("desktop:ssh:ensure", target, request),
  issueSshPairingCredential: (id: string, expectedId: string) => sshInvoke("desktop:ssh:pairing", id, expectedId),
  claimSshConnection: (id: string, expectedId: string) => sshInvoke("desktop:ssh:claim", id, expectedId),
  cancelSshConnection: (id: string) => sshInvoke("desktop:ssh:cancel", id),
  disconnectSshConnection: (target: DesktopSshTarget) => sshInvoke("desktop:ssh:disconnect", target),
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

async function sshInvoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result: DesktopSshResult<T> = await ipcRenderer.invoke(channel, ...args);
  if (result.ok) return result.value;
  // Electron otherwise discards custom error fields during invoke serialization.
  // Reconstruct only the bounded, typed failure supplied by trusted main code.
  const categories = ["transport", "authentication", "permission", "configuration", "unsupported", "identity", "cancelled"];
  const category = categories.includes(result.error.category) ? result.error.category : "transport";
  const error = new Error(typeof result.error.message === "string" ? result.error.message.slice(0, 512) : "SSH operation failed.") as Error & { category: string };
  error.name = "DesktopSshError";
  error.category = category;
  throw error;
}
