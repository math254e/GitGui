import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("secretPrompt", Object.freeze({
  submit: (value: string) => ipcRenderer.send("desktop:secret-prompt:response", value),
  cancel: () => ipcRenderer.send("desktop:secret-prompt:response", null),
}));
