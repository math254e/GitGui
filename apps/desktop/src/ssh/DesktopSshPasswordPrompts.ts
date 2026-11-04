// Adapted from T3 Code 70cd258d8aac43ea57494527b00bf36de3efa6c0
// apps/desktop/src/ssh/DesktopSshPasswordPrompts.ts. GitGui presents a narrow modal
// window rather than exposing authentication secrets to the application renderer.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BrowserWindow, dialog, ipcMain } from "electron";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { SshFailure, type SshHostTrustRequest } from "@gitgui/ssh";

export interface PasswordPresentation {
  close(): void;
}
export interface PasswordPresenter {
  present(id: string, prompt: string, respond: (secret: string | null) => void): PasswordPresentation;
}
const authFailure = () => new SshFailure({ category: "authentication", message: "SSH authentication was cancelled, expired, or its window is unavailable." });

export const makePasswordPrompts = Effect.fn("desktop.ssh.prompts.make")(function* (presenter: PasswordPresenter, timeoutMs = 180_000) {
  const pending = new Map<string, Deferred.Deferred<string | null, SshFailure>>();
  let stopped = false;
  yield* Effect.addFinalizer(() => Effect.sync(() => {
    stopped = true;
    for (const deferred of pending.values()) Deferred.doneUnsafe(deferred, Effect.fail(authFailure()));
    pending.clear();
  }));
  return {
    request: (prompt: string) => Effect.scoped(Effect.gen(function* () {
      if (stopped) return yield* authFailure();
      const id = randomUUID();
      const deferred = yield* Deferred.make<string | null, SshFailure>();
      pending.set(id, deferred);
      yield* Effect.addFinalizer(() => Effect.sync(() => { pending.delete(id); }));
      const presentation = yield* Effect.try({
        try: () => presenter.present(id, prompt, secret => {
          const current = pending.get(id);
          if (current !== deferred) return;
          // Remove before completion so a closed/late window cannot submit again.
          pending.delete(id);
          Deferred.doneUnsafe(deferred, typeof secret === "string" && secret.length <= 16 * 1024 ? Effect.succeed(secret) : Effect.fail(authFailure()));
        }), catch: authFailure,
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => { pending.delete(id); presentation.close(); }));
      return yield* Deferred.await(deferred).pipe(Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.fail(authFailure()) }));
    })),
  };
});

export const nativePasswordPresenter = (getParent: () => BrowserWindow | null): PasswordPresenter => ({
  present(id, prompt, respond) {
    const parent = getParent();
    if (!parent || parent.isDestroyed()) throw authFailure();
    const window = new BrowserWindow({
      parent, modal: true, width: 480, height: 250, show: false, resizable: false, minimizable: false, maximizable: false, title: "SSH authentication",
      webPreferences: { preload: join(import.meta.dirname, "..", "prompt-preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, additionalArguments: [`--gitgui-prompt-id=${id}`] },
    });
    const onResponse = (event: Electron.IpcMainEvent, requestId: unknown, value: unknown) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || requestId !== id) return;
      respond(typeof value === "string" && value.length <= 16 * 1024 ? value : null);
    };
    const onClosed = () => respond(null);
    const onParentClosed = () => respond(null);
    const close = () => {
      ipcMain.removeListener("desktop:secret-prompt:response", onResponse);
      parent.removeListener("closed", onParentClosed);
      window.removeListener("closed", onClosed);
      if (!window.isDestroyed()) window.destroy();
    };
    try {
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", event => event.preventDefault());
      ipcMain.on("desktop:secret-prompt:response", onResponse);
      window.once("closed", onClosed);
      parent.once("closed", onParentClosed);
      const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>body{font:14px system-ui;margin:24px;background:#15171c;color:#f4f4f5}label{display:block;margin-bottom:10px}input{box-sizing:border-box;width:100%;padding:9px;background:#22252c;color:white;border:1px solid #454955;border-radius:5px}.buttons{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}button{padding:7px 14px}</style><form><label for="secret">${escapeHtml(prompt)}</label><input id="secret" type="password" autofocus autocomplete="current-password"><div class="buttons"><button type="button" id="cancel">Cancel</button><button type="submit">Connect</button></div></form><script>const api=window.secretPrompt;const input=document.querySelector('#secret');document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();const value=input.value;input.value='';api.submit(value)});document.querySelector('#cancel').addEventListener('click',()=>api.cancel());</script>`;
      window.once("ready-to-show", () => { if (!window.isDestroyed()) { window.show(); window.focus(); } });
      void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => respond(null));
      return { close };
    } catch {
      close();
      throw authFailure();
    }
  },
});

export const confirmHostTrust = (getParent: () => BrowserWindow | null, input: SshHostTrustRequest): Effect.Effect<boolean, SshFailure> => Effect.tryPromise({
  try: async signal => {
    const parent = getParent();
    if (!parent || parent.isDestroyed()) throw authFailure();
    const result = await dialog.showMessageBox(parent, { signal, type: "warning", title: "Confirm SSH host identity",
      message: `Trust ${input.alias} (${input.hostname}:${input.port})?`,
      detail: `Verify these host key fingerprints through a trusted channel before accepting:\n\n${input.fingerprints.join("\n")}\n\nOnly these keys will be added to your OpenSSH known_hosts file.`,
      buttons: ["Cancel", "Trust verified keys"], defaultId: 0, cancelId: 0, noLink: true,
    });
    return !signal.aborted && result.response === 1;
  }, catch: () => new SshFailure({ category: "permission", message: "SSH host confirmation was cancelled or unavailable." }),
});
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
