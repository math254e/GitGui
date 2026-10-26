// @vitest-environment happy-dom
/** Opt-in end-to-end measurement: real temporary Git repository, authenticated
 * shared runtime/RPC, Rust server, store, and mounted staging/dialog components.
 * Build an isolated server binary and set GITGUI_DISCARD_IT=1. No CI timing bound.
 */
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { mount, tick, unmount } from "svelte";
// @ts-expect-error Svelte's compiler runtime has no public module declarations.
import { effect_root, flush } from "svelte/internal/client";
import { expect, it, vi } from "vitest";
import type { DesktopBridge, DesktopPreparedConnection } from "@gitgui/contracts/desktop";
import { WebApplicationRuntime, type WebApplicationRuntimeState } from "../connection/runtime";
import { InMemoryWorkspaceMetadataAdapter } from "../client-runtime/metadata";
import type { ClientWorkspace } from "../client-runtime/workspace";
import type { WorkspaceStore } from "./workspace-store.svelte";
import DiscardLifecycle from "../components/__tests__/DiscardLifecycle.svelte";

const notices = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock("svelte-sonner", () => ({ toast: notices }));
vi.mock("@lucide/svelte", () => ({ Check: () => {}, LoaderCircle: () => {}, Plus: () => {}, Minus: () => {} }));
const root = resolve(__dirname, "../../../../../");
const storage = (): Storage => {
  const data = new Map<string, string>();
  return { get length() { return data.size; }, clear: () => data.clear(), key: (i) => [...data.keys()][i] ?? null,
    getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); } };
};

const cases = [1, 20].flatMap((count) => [0, 1, 2].map((sample) => ({ count, sample })));
it.skipIf(process.env["GITGUI_DISCARD_IT"] !== "1").each(cases)("measures $count files, sample $sample, through rendered rows and result", async ({ count, sample }) => {
  const temp = await mkdtemp(join(tmpdir(), "gitgui-discard-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: temp, stdio: "pipe", windowsHide: true });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Discard measurement"]);
  git(["config", "user.email", "measurement@example.com"]);
  git(["config", "core.autocrlf", "false"]);
  const paths = Array.from({ length: 20 }, (_, i) => `file-${i}.txt`);
  for (const path of paths) await writeFile(join(temp, path), "base\n");
  git(["add", "."]); git(["commit", "-qm", "base"]);
  let runtime: WebApplicationRuntime | undefined;
  let workspace: ClientWorkspace | undefined;
  let disposeStore: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  let component: ReturnType<typeof mount> | undefined;
  const binary = process.env["GITGUI_DISCARD_BINARY"] ?? join(root, "target/discard-benchmark/debug/gitgui-server");
  const child = spawn(resolve(binary), ["--bind", "127.0.0.1", "--port", "0", "--ephemeral", "--repository", temp], {
    env: { ...process.env, GITGUI_SERVER_BOOTSTRAP_STDIN: "1", GITGUI_SERVER_ADDITIONAL_ORIGINS: window.location.origin, RUST_LOG: "error" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  const bootstrap = randomUUID();
  child.stdin.end(`${bootstrap}\n`);
  child.stderr.resume();
  try {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    // ws is already installed as part of the workspace's development tooling.
    vi.stubGlobal("WebSocket", createRequire(join(root, "package.json"))("ws") as typeof WebSocket);
    const httpUrl = await new Promise<string>((done, fail) => {
      let buffer = "";
      const timer = setTimeout(() => fail(new Error("Isolated measurement server readiness timed out")), 15_000);
      child.once("error", (error) => { clearTimeout(timer); fail(error); });
      child.once("exit", () => { clearTimeout(timer); fail(new Error("Measurement server exited")); });
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
        for (const line of lines) if (line.startsWith("GITGUI_SERVER_READY=")) {
          clearTimeout(timer);
          done(`http://${(JSON.parse(line.slice("GITGUI_SERVER_READY=".length)) as { address: string }).address}`);
        }
      });
    });
    const descriptor = await fetch(`${httpUrl}/.well-known/gitgui/environment`).then((response) => response.json());
    const prepared: DesktopPreparedConnection = { httpUrl, descriptor, credential: { kind: "bootstrap", token: bootstrap } };
    const desktop: Partial<DesktopBridge> = { getPrimaryEnvironment: async () => prepared, listConnectionRegistrations: async () => [],
      getCredential: async () => undefined, setCredential: async () => {}, onApplicationWakeup: () => () => {} };
    runtime = new WebApplicationRuntime({ desktop: desktop as DesktopBridge, storage: storage(), fetchFn: fetch });
    await runtime.start();
    await vi.waitFor(() => expect(runtime!.state.client).not.toBeNull(), { timeout: 15_000 });
    const client = runtime.state.client!;
    const opened = await client.openRepository(temp);
    const environmentId = client.serverWelcome.environment_id;
    // Baseline modules are generated from the base commit for local comparison;
    // the normal opt-in run always uses the current implementations.
    const workspaceModule = process.env["GITGUI_DISCARD_WORKSPACE_MODULE"] ?? "../client-runtime/workspace";
    const storeModule = process.env["GITGUI_DISCARD_STORE_MODULE"] ?? "./workspace-store.svelte";
    const { ClientWorkspace: Workspace } = await import(workspaceModule) as typeof import("../client-runtime/workspace");
    const { WorkspaceStore: Store } = await import(storeModule) as typeof import("./workspace-store.svelte");
    const metadataAdapter = new InMemoryWorkspaceMetadataAdapter([{ identity: { environmentId }, metadata: { schemaVersion: 1,
      openRepositoryIds: [opened.repository.id], activeRepositoryId: opened.repository.id, recentRepositories: [] } }]);
    workspace = new Workspace({ client, identity: { environmentId }, metadataAdapter });
    workspace.startUpdates(); await workspace.restore();
    const projected: WebApplicationRuntimeState = { ...runtime.state, workspace, workspaceState: workspace.state };
    let store!: WorkspaceStore;
    disposeStore = effect_root(() => { store = new Store({ isDesktop: true, get state() { return projected; } } as WebApplicationRuntime); });
    const internals = store as unknown as { applyWorkspaceState(state: ClientWorkspace["state"]): void; connectionEnvironmentId: string };
    store.client = client; store.workspace = workspace; internals.connectionEnvironmentId = environmentId;
    unsubscribe = workspace.subscribe((state) => { projected.workspaceState = state; internals.applyWorkspaceState(state); });
    flush();
    const target = document.createElement("div"); document.body.append(target);
    component = mount(DiscardLifecycle, { target, props: { store } });
    flush(); await tick();
    const originalDiscard = client.discard.bind(client);
    const statusReads = vi.spyOn(client, "getGitStatus");
    const snapshotReads = vi.spyOn(client, "refreshRepositories");
    const amendReads = vi.spyOn(client, "getAmendInfo");
    let confirmed = 0, receiptMs = 0, noticeMs = 0;
    let discardCalls = 0;
    vi.spyOn(client, "discard").mockImplementation(async (params) => {
      discardCalls += 1;
      const result = await originalDiscard(params);
      receiptMs = performance.now() - confirmed;
      return result;
    });
    notices.success.mockImplementation(() => { noticeMs = performance.now() - confirmed; });
    {
      const selected = paths.slice(0, count);
      for (const path of selected) await writeFile(join(temp, path), "x".repeat(4096));
      await workspace.refreshRepositoryStatus(opened.repository.id);
      // Let filesystem invalidations already caused by fixture writes settle.
      await new Promise((done) => setTimeout(done, 300));
      await tick();
      await vi.waitFor(() => {
        flush();
        expect(store.snapshot?.status.changedFiles).toHaveLength(count);
        expect(target.querySelectorAll('[aria-label="Stage files"] button')).toHaveLength(count);
      }, { timeout: 15_000, interval: 10 });
      await vi.waitFor(() => expect(store.amendLoading).toBe(false), { timeout: 15_000, interval: 10 });
      await store.openDiscard(selected);
      flush(); await tick();
      const button = [...target.querySelectorAll<HTMLButtonElement>("dialog button")].find((entry) => entry.textContent?.trim() === `Discard ${count} ${count === 1 ? "file" : "files"}`)!;
      expect(button).toBeTruthy();
      const calls = discardCalls;
      const beforeReads = [statusReads.mock.calls.length, snapshotReads.mock.calls.length, amendReads.mock.calls.length];
      const panel = target.querySelector("section");
      confirmed = performance.now(); receiptMs = 0; noticeMs = 0;
      button.click();
      flush(); await tick();
      const dialogClosedMs = performance.now() - confirmed;
      expect(target.querySelector<HTMLDialogElement>("dialog")?.open).toBe(false);
      await vi.waitFor(() => {
        flush();
        expect(receiptMs).toBeGreaterThan(0);
        expect(target.querySelectorAll('[aria-label="Stage files"] button')).toHaveLength(0);
        expect(store.snapshot?.status.changedFiles).toHaveLength(0);
      }, { timeout: 30_000, interval: 5 });
      await tick();
      const rowsMs = performance.now() - confirmed;
      await vi.waitFor(() => expect(noticeMs).toBeGreaterThan(0), { timeout: 30_000, interval: 5 });
      expect(discardCalls - calls).toBe(1);
      expect(store.gitActionPending).toBe(false);
      // A status update may change rows but must retain the panel's DOM owner.
      expect(target.querySelector("section")).toBe(panel);
      const reads = [statusReads.mock.calls.length, snapshotReads.mock.calls.length, amendReads.mock.calls.length].map((value, i) => value - beforeReads[i]);
      console.log(JSON.stringify({ label: process.env["GITGUI_DISCARD_LABEL"] ?? "after", files: count, sample, dialogClosedMs, receiptMs, rowsMs, noticeMs, reads }));
    }
  } finally {
    if (component) await unmount(component);
    unsubscribe?.(); disposeStore?.(); workspace?.dispose(); await runtime?.stop();
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
    vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren();
    // Exact isolated fixture directory; no user repository is mutated or removed.
    await rm(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}, 180_000);
