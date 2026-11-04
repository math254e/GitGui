import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { DESKTOP_QUIT_MESSAGE, runDesktopSession } from "./dev-session.mjs";

const timeoutMs = 5_000;
const viteProgram = "setInterval(() => {}, 1000)";
const desktopProgram = String.raw`
  const { spawn } = require('node:child_process');
  const backend = spawn(process.execPath, ['-e', "process.on('message', message => { if (message === 'test:stop-backend') { process.send({ type: 'stop-request-handled' }); setTimeout(() => process.exit(0), 120); } }); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let quitting = false;
  let backendHandledStop = false;
  backend.on('message', message => { if (message?.type === 'stop-request-handled') backendHandledStop = true; });
  const stopBackendThenExit = () => {
    backend.send('test:stop-backend');
    backend.once('exit', (code, signal) => {
      process.send({ type: 'backend-stopped', code, signal, handledStop: backendHandledStop });
      setTimeout(() => process.exit(0), 100);
    });
  };
  process.on('message', message => {
    if (message === 'test:close-window') { stopBackendThenExit(); return; }
    if (message !== 'gitgui:dev:quit' || quitting) return;
    quitting = true;
    process.send({ type: 'quit-received', message });
    setTimeout(stopBackendThenExit, 275);
  });
  backend.once('spawn', () => process.send({ type: 'backend-started', pid: backend.pid }));
  backend.once('error', error => { process.send({ type: 'backend-error', message: error.message }); process.exit(2); });
  setInterval(() => {}, 1000);
`;

function startVite() {
  return spawn(process.execPath, ["-e", viteProgram], { stdio: "ignore" });
}

function startDesktop() {
  return spawn(process.execPath, ["-e", desktopProgram], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    // A child must actually spawn before readiness can succeed; this also
    // makes a failed executable a startup failure instead of a late desktop.
    const spawned = () => { child.off("error", failed); resolve(); };
    const failed = error => { child.off("spawn", spawned); reject(error); };
    child.once("spawn", spawned);
    child.once("error", failed);
  });
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, "exit");
}

function messageOf(child, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for fixture message: ${type}`)); }, timeoutMs);
    const onMessage = message => {
      if (message?.type !== type) return;
      cleanup();
      resolve(message);
    };
    const onExit = (code, signal) => { cleanup(); reject(new Error(`Fixture exited before ${type} (code=${code}, signal=${signal})`)); };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

async function cleanupChildren(children) {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    if (child.connected) {
      try { child.send("test:close-window"); } catch { child.kill("SIGTERM"); }
    } else {
      try { child.kill("SIGTERM"); } catch {}
    }
  }
  await Promise.all(children.map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await Promise.race([once(child, "exit"), delay(timeoutMs).then(() => { throw new Error(`Owned fixture ${child.pid} did not exit`); })]);
  }));
}

function spawnErrorProgram() {
  return spawn("gitgui-test-command-that-does-not-exist", [], { stdio: "ignore" });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  test(`${signal} sends one graceful desktop quit and waits for backend and desktop cleanup`, { timeout: 10_000 }, async t => {
    const signals = new EventEmitter();
    let vite;
    let desktop;
    let desktopExited = false;
    const desktopReady = deferred();
    const reports = [];
    let desktopKillCalls = 0;
    const session = runDesktopSession({
      startVite: () => (vite = startVite()),
      startDesktop: () => {
        desktop = startDesktop();
        const kill = desktop.kill.bind(desktop);
        desktop.kill = (...args) => { desktopKillCalls++; return kill(...args); };
        desktopReady.resolve(desktop);
        return desktop;
      },
      waitForReady,
      signals,
      report: message => reports.push(message),
      shutdownNoticeMs: 30,
    });
    t.after(() => cleanupChildren([desktop, vite].filter(Boolean)));

    desktop = await desktopReady.promise;
    desktop.once("exit", () => { desktopExited = true; });
    await messageOf(desktop, "backend-started");
    const quit = messageOf(desktop, "quit-received");
    signals.emit(signal);
    assert.equal((await quit).message, DESKTOP_QUIT_MESSAGE);
    const backendStopped = messageOf(desktop, "backend-stopped");
    await delay(40);
    signals.emit(signal);
    signals.emit("SIGINT");
    const backend = await backendStopped;
    assert.equal(backend.code, 0);
    assert.equal(backend.handledStop, true, "the backend completed its graceful stop handler before desktop exit");
    assert.equal(await session, 0);
    assert.equal(desktopExited, true, "the session resolves only after the desktop child exits");
    await waitForExit(desktop);
    await waitForExit(vite);
    assert.equal(desktop.exitCode, 0);
    assert.notEqual(vite.exitCode ?? vite.signalCode, null);
    assert.equal(desktopKillCalls, 0);
    assert.equal(reports.length, 1, "one shutdown notice is emitted while delayed cleanup is pending");
    assert.equal(signals.listenerCount("SIGINT"), 0);
    assert.equal(signals.listenerCount("SIGTERM"), 0);
    assert.equal(signals.listenerCount("SIGHUP"), 0);
  });
}

test("Vite exit after readiness returns 1 and asks desktop to shut down gracefully", { timeout: 10_000 }, async t => {
  const signals = new EventEmitter();
  let vite;
  let desktop;
  const desktopReady = deferred();
  const session = runDesktopSession({ startVite: () => (vite = startVite()), startDesktop: () => { desktop = startDesktop(); desktopReady.resolve(desktop); return desktop; }, waitForReady, signals, report: () => {} });
  t.after(() => cleanupChildren([desktop, vite].filter(Boolean)));
  desktop = await desktopReady.promise;
  await messageOf(desktop, "backend-started");
  const quit = messageOf(desktop, "quit-received");
  vite.kill("SIGTERM");
  assert.equal((await quit).message, DESKTOP_QUIT_MESSAGE);
  await messageOf(desktop, "backend-stopped");
  assert.equal(await session, 1);
  await waitForExit(desktop);
  assert.equal(desktop.exitCode, 0);
});

test("startup/readiness failure stops Vite and does not launch desktop", { timeout: 10_000 }, async t => {
  const signals = new EventEmitter();
  let vite;
  let desktopStarts = 0;
  const session = runDesktopSession({
    startVite: () => (vite = startVite()),
    startDesktop: () => { desktopStarts++; return startDesktop(); },
    waitForReady: async () => { throw new Error("readiness failed"); },
    signals,
    report: () => {},
  });
  t.after(() => cleanupChildren([vite].filter(Boolean)));
  assert.equal(await session, 1);
  assert.equal(desktopStarts, 0);
  await waitForExit(vite);
});

test("cancel during readiness prevents a late desktop launch", { timeout: 10_000 }, async t => {
  const signals = new EventEmitter();
  let vite;
  let desktopStarts = 0;
  let resolveReady;
  const session = runDesktopSession({
    startVite: () => (vite = startVite()),
    startDesktop: () => { desktopStarts++; return startDesktop(); },
    waitForReady: () => new Promise(resolve => { resolveReady = resolve; }),
    signals,
    report: () => {},
  });
  t.after(() => cleanupChildren([vite].filter(Boolean)));
  while (!resolveReady) await delay(1);
  signals.emit("SIGINT");
  await waitForExit(vite);
  resolveReady();
  assert.equal(await session, 0);
  await delay(25);
  assert.equal(desktopStarts, 0);
  assert.notEqual(vite.exitCode ?? vite.signalCode, null);
});

test("normal desktop close returns 0 and stops Vite", { timeout: 10_000 }, async t => {
  const signals = new EventEmitter();
  let vite;
  let desktop;
  const desktopReady = deferred();
  const session = runDesktopSession({ startVite: () => (vite = startVite()), startDesktop: () => { desktop = startDesktop(); desktopReady.resolve(desktop); return desktop; }, waitForReady, signals, report: () => {} });
  t.after(() => cleanupChildren([desktop, vite].filter(Boolean)));
  desktop = await desktopReady.promise;
  await messageOf(desktop, "backend-started");
  desktop.send("test:close-window");
  await messageOf(desktop, "backend-stopped");
  assert.equal(await session, 0);
  await waitForExit(vite);
});

test("Vite spawn error returns 1 without starting desktop", { timeout: 10_000 }, async t => {
  const signals = new EventEmitter();
  let desktopStarts = 0;
  const session = runDesktopSession({
    startVite: spawnErrorProgram,
    startDesktop: () => { desktopStarts++; return startDesktop(); },
    waitForReady,
    signals,
    report: () => {},
  });
  assert.equal(await session, 1);
  assert.equal(desktopStarts, 0);
});

test("desktop spawn error returns 1 and stops Vite", { timeout: 10_000 }, async t => {
  const signals = new EventEmitter();
  let vite;
  const session = runDesktopSession({ startVite: () => (vite = startVite()), startDesktop: spawnErrorProgram, waitForReady, signals, report: () => {} });
  t.after(() => cleanupChildren([vite].filter(Boolean)));
  assert.equal(await session, 1);
  await waitForExit(vite);
});
