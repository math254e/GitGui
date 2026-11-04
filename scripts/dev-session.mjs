// GitGui's two-child development lifetime. The desktop owns Rust and SSH;
// only it can drain those resources safely before exiting.
export const DESKTOP_QUIT_MESSAGE = "gitgui:dev:quit";

export async function runDesktopSession({ startVite, startDesktop, waitForReady, signals = process, report = console.error, shutdownNoticeMs = 30_000 }) {
  const readiness = new AbortController();
  let vite;
  let desktop;
  let closing = false;
  let finishing;
  let finish;
  const completed = new Promise(resolve => { finish = resolve; });

  const observe = (child, exited) => {
    let resolve;
    const record = { child, alive: true, exited: new Promise(done => { resolve = done; }) };
    const ended = code => {
      if (!record.alive) return;
      record.alive = false;
      resolve();
      exited(code);
    };
    child.once("exit", code => ended(code ?? 1));
    child.once("error", () => ended(1));
    if (child.exitCode !== null || child.signalCode !== null) ended(child.exitCode ?? 1);
    return record;
  };

  const shutdown = code => {
    if (closing) return finishing;
    closing = true;
    readiness.abort();
    finishing = (async () => {
      if (desktop?.alive) {
        // No signal/kill fallback: it would bypass before-quit and abandon Rust.
        // The inherited IPC channel is private to this exact spawned child.
        try {
          desktop.child.send(DESKTOP_QUIT_MESSAGE, error => {
            if (error && desktop.alive) report("[gitgui] Could not deliver desktop quit; waiting for its normal exit.");
          });
        } catch {
          report("[gitgui] Could not deliver desktop quit; close the desktop window to finish shutdown.");
        }
        const notice = setTimeout(() => report("[gitgui] Waiting for desktop cleanup. The desktop will not be force-terminated."), shutdownNoticeMs);
        try { await desktop.exited; } finally { clearTimeout(notice); }
      }
      if (vite?.alive) {
        vite.child.kill("SIGTERM");
        await vite.exited;
      }
      finish(code);
    })();
    return finishing;
  };
  const stop = () => { void shutdown(0); };
  const signalNames = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signalNames) signals.on(signal, stop);
  try {
    vite = observe(startVite(), () => {
      if (!closing) {
        report("[gitgui] Vite exited; shutting down the development desktop.");
        void shutdown(1);
      }
    });
    await waitForReady(vite.child, readiness.signal);
    // Cancellation while readiness was resolving must not start a late desktop.
    if (!closing) desktop = observe(startDesktop(), code => { void shutdown(code); });
  } catch (error) {
    if (!closing) {
      report(`[gitgui] ${error instanceof Error ? error.message : "Development launch failed."}`);
      void shutdown(1);
    }
  }
  try { return await completed; }
  finally {
    for (const signal of signalNames) signals.off(signal, stop);
  }
}
