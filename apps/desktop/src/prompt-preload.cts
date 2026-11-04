import { contextBridge, ipcRenderer } from "electron";

const requestId = process.argv.find(value => value.startsWith("--gitgui-prompt-id="))?.slice("--gitgui-prompt-id=".length);

contextBridge.exposeInMainWorld("secretPrompt", Object.freeze({
  submit: (value: string) => { if (requestId && typeof value === "string" && value.length <= 16 * 1024) ipcRenderer.send("desktop:secret-prompt:response", requestId, value); },
  cancel: () => { if (requestId) ipcRenderer.send("desktop:secret-prompt:response", requestId, null); },
}));
