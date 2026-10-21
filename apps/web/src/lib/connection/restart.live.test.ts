/**
 * Opt-in adapter test with real Rust servers, isolated persistent state, and a
 * desktop bridge fixture. Build gitgui-server first, then run with GITGUI_IT=1.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import type { DesktopBridge, DesktopCredential, DesktopPreparedConnection } from "@gitgui/contracts/desktop";
import { WebApplicationRuntime } from "./runtime";

const binary = fileURLToPath(new URL("../../../../../target/debug/gitgui-server", import.meta.url));
const repository = fileURLToPath(new URL("../../../../../", import.meta.url));
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, clear: () => values.clear(), key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); } };
}
const alive = (child: ChildProcessWithoutNullStreams) => child.exitCode === null && child.signalCode === null;
async function stop(child: ChildProcessWithoutNullStreams) {
  if (!alive(child)) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, 5000); })]);
    if (alive(child)) { child.kill("SIGKILL"); await exited; }
  } finally { clearTimeout(timer); }
}

it.skipIf(process.env["GITGUI_IT"] !== "1")("reconnects after a crash, an explicit primary restart, and reopening with cached credentials", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "gitgui-primary-restart-"));
  const owned = new Set<ChildProcessWithoutNullStreams>();
  type Running = { child: ChildProcessWithoutNullStreams; prepared: DesktopPreparedConnection };
  let current: Running | undefined;
  let starting: Promise<Running> | undefined;
  let generation = 0;
  let runtime: WebApplicationRuntime | undefined;
  const launch = async (): Promise<Running> => {
    const token = `test-primary-bootstrap-${++generation}`;
    const child = spawn(binary, ["--bind", "127.0.0.1", "--port", "0", "--data-dir", dataDir, "--repository", repository], {
      env: { ...process.env, GITGUI_SERVER_BOOTSTRAP_STDIN: "1", RUST_LOG: "error" }, stdio: ["pipe", "pipe", "pipe"],
    });
    owned.add(child);
    child.stdin.end(`${token}\n`);
    child.stderr.resume();
    const httpUrl = await new Promise<string>((resolve, reject) => {
      let buffered = "";
      const timer = setTimeout(() => finish(new Error("Isolated server readiness timed out.")), 10_000);
      const finish = (error?: Error, address?: string) => {
        clearTimeout(timer);
        child.stdout.off("data", onData); child.off("exit", onExit); child.off("error", onError);
        if (error) reject(error); else resolve(`http://${address}`);
      };
      const onExit = () => finish(new Error("Isolated server exited before readiness."));
      const onError = (error: Error) => finish(error);
      const onData = (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("GITGUI_SERVER_READY=")) {
            const ready = JSON.parse(line.slice("GITGUI_SERVER_READY=".length)) as { address: string };
            finish(undefined, ready.address); return;
          }
        }
      };
      child.stdout.on("data", onData); child.once("exit", onExit); child.once("error", onError);
    });
    child.stdout.resume();
    const descriptor = await fetch(`${httpUrl}/.well-known/gitgui/environment`).then((response) => response.json());
    return { child, prepared: { httpUrl, descriptor, credential: { kind: "bootstrap", token } } };
  };
  const connection = async () => {
    if (current !== undefined && alive(current.child)) return current.prepared;
    if (starting === undefined) starting = launch();
    try { current = await starting; return current.prepared; }
    finally { starting = undefined; }
  };
  try {
    vi.stubGlobal("window", Object.assign(new EventTarget(), { location: new URL("http://localhost") }));
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
    vi.stubGlobal("navigator", { onLine: true });
    const credentials = new Map<string, DesktopCredential>();
    const desktop: Partial<DesktopBridge> = {
      getPrimaryEnvironment: connection,
      restartPrimaryEnvironment: async () => { if (current) await stop(current.child); return connection(); },
      listConnectionRegistrations: async () => [],
      getCredential: async (id) => credentials.get(id),
      setCredential: async (id, credential) => { credentials.set(id, credential); },
      onApplicationWakeup: () => () => undefined,
    };
    const options = { desktop: desktop as DesktopBridge, storage: memoryStorage(), fetchFn: fetch };
    runtime = new WebApplicationRuntime(options);
    await runtime.start();
    await vi.waitFor(() => expect(runtime!.state.client).not.toBeNull(), { timeout: 10_000 });
    const environmentId = runtime.state.client!.serverWelcome.environment_id;
    // Opening paths requires the bootstrap grant's catalog-management scope,
    // beyond the read/operate scopes sufficient for status and discovery.
    const opened = await runtime.state.client!.openRepository(repository);
    expect(opened.repository.id).toBeTruthy();
    const firstUrl = current!.prepared.httpUrl;
    const firstToken = credentials.get(environmentId)!.token;

    await stop(current!.child);
    await vi.waitFor(() => {
      expect(current!.prepared.httpUrl).not.toBe(firstUrl);
      expect(runtime!.state.client?.serverWelcome.environment_id).toBe(environmentId);
      expect(credentials.get(environmentId)?.token === firstToken).toBe(false);
    }, { timeout: 12_000 });
    expect((await runtime.state.client!.getServerStatus()).ready).toBe(true);

    const previousUrl = current!.prepared.httpUrl;
    await runtime.retrySelected(true);
    await vi.waitFor(() => expect(runtime!.state.client?.serverWelcome.environment_id).toBe(environmentId), { timeout: 10_000 });
    expect(current!.prepared.httpUrl).not.toBe(previousUrl);
    expect((await runtime.state.client!.getServerStatus()).ready).toBe(true);

    await runtime.stop();
    const cachedToken = credentials.get(environmentId)!.token;
    await stop(current!.child);
    runtime = new WebApplicationRuntime(options);
    await runtime.start();
    await vi.waitFor(() => expect(runtime!.state.client?.serverWelcome.environment_id).toBe(environmentId), { timeout: 10_000 });
    expect(credentials.get(environmentId)?.token === cachedToken).toBe(false);
    expect((await runtime.state.client!.getServerStatus()).ready).toBe(true);
  } finally {
    await runtime?.stop();
    if (starting) await starting.catch(() => undefined);
    for (const child of owned) await stop(child);
    vi.unstubAllGlobals();
    // Only the exact isolated directory created by this fixture is removed.
    await rm(dataDir, { recursive: true, force: true });
  }
}, 45_000);
