import { ConnectionDriver } from "./driver";
import type {
  ConnectionFailure as ConnectionFailureType,
  ConnectionPlatform,
  ConnectionRegistration,
  EnvironmentConnectionState,
  RpcSession,
  RuntimeWakeup,
} from "./model";
import { ConnectionFailure } from "./model";

const RETRY_DELAYS_MS = [3_000, 4_000, 8_000, 16_000] as const;
const STABLE_CONNECTION_MS = 30_000;

export type SupervisorListener = (state: EnvironmentConnectionState, session: RpcSession | null) => void;

export class EnvironmentSupervisor {
  private stateValue: EnvironmentConnectionState;
  private sessionValue: RpcSession | null = null;
  private readonly listeners = new Set<SupervisorListener>();
  private wakeVersion = 0;
  private wakeReason: RuntimeWakeup | "network" | "disconnect" = "explicit-retry";
  private wakeResolvers = new Set<() => void>();
  private runPromise?: Promise<void>;
  private attemptController?: AbortController;
  private unsubscribeNetwork?: () => void;
  private unsubscribeWakeups?: () => void;

  constructor(
    readonly registration: ConnectionRegistration,
    private readonly driver: ConnectionDriver,
    private readonly platform: ConnectionPlatform,
  ) {
    this.stateValue = {
      desired: false,
      network: platform.isOnline() ? "online" : "offline",
      phase: "idle",
      stage: null,
      attempt: 0,
      generation: 0,
      lastFailure: null,
      retryAt: null,
    };
  }

  get state(): EnvironmentConnectionState {
    return { ...this.stateValue };
  }

  get session(): RpcSession | null {
    return this.sessionValue;
  }

  subscribe(listener: SupervisorListener): () => void {
    this.listeners.add(listener);
    listener(this.state, this.sessionValue);
    return () => this.listeners.delete(listener);
  }

  connect(): void {
    if (this.stateValue.desired) return;
    this.patch({ desired: true, phase: this.stateValue.network === "online" ? "idle" : "offline" });
    this.unsubscribeNetwork = this.platform.subscribeNetwork((online) => {
      this.patch({ network: online ? "online" : "offline" });
      if (!online) {
        this.attemptController?.abort();
        this.releaseSession("Network offline");
      }
      this.wake("network");
    });
    this.unsubscribeWakeups = this.platform.subscribeWakeups((reason) => this.wake(reason));
    this.runPromise = this.run();
  }

  retry(): void {
    this.attemptController?.abort();
    this.wake("explicit-retry");
  }

  credentialChanged(): void {
    this.attemptController?.abort();
    this.wake("credential-changed");
  }

  async disconnect(): Promise<void> {
    if (!this.stateValue.desired && this.stateValue.phase === "stopped") return;
    this.patch({ desired: false, phase: "stopped", stage: null, retryAt: null });
    this.attemptController?.abort();
    this.releaseSession("Environment disconnected");
    this.wake("disconnect");
    this.unsubscribeNetwork?.();
    this.unsubscribeWakeups?.();
    this.unsubscribeNetwork = undefined;
    this.unsubscribeWakeups = undefined;
    await this.runPromise;
    this.runPromise = undefined;
  }

  waitUntilConnected(signal?: AbortSignal): Promise<RpcSession> {
    if (this.sessionValue && this.stateValue.phase === "connected") return Promise.resolve(this.sessionValue);
    return new Promise((resolve, reject) => {
      let unsubscribe: () => void = () => undefined;
      const onAbort = () => {
        cleanup();
        reject(new DOMException("Connection wait cancelled", "AbortError"));
      };
      const cleanup = () => {
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      unsubscribe = this.subscribe((state, session) => {
        if (state.phase === "connected" && session) {
          cleanup();
          resolve(session);
        } else if (state.phase === "blocked" || state.phase === "stopped") {
          cleanup();
          reject(state.lastFailure ?? new ConnectionFailure("Environment is not connectable", "configuration", false));
        }
      });
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async run(): Promise<void> {
    while (this.stateValue.desired) {
      if (this.stateValue.network === "offline") {
        this.patch({ phase: "offline", stage: null, retryAt: null });
        await this.waitForWake(this.wakeVersion);
        continue;
      }

      const controller = new AbortController();
      this.attemptController = controller;
      try {
        this.patch({
          phase: this.stateValue.attempt === 0 ? "preparing" : "waiting",
          stage: "resolving",
          retryAt: null,
        });
        const session = await this.driver.connect(this.registration, controller.signal, (stage) => {
          this.patch({
            stage,
            phase: stage === "opening" ? "opening" : stage === "synchronizing" ? "synchronizing" : "preparing",
          });
        });
        if (!this.stateValue.desired || this.isOffline()) {
          session.close("Connection no longer desired");
          continue;
        }
        this.sessionValue = session;
        const connectedAt = Date.now();
        this.patch({
          phase: "connected",
          stage: null,
          generation: this.stateValue.generation + 1,
          lastFailure: null,
          retryAt: null,
        });
        await this.monitorConnected(session);
        if (Date.now() - connectedAt >= STABLE_CONNECTION_MS) this.patch({ attempt: 0 });
      } catch (error) {
        if (!this.stateValue.desired) break;
        if (this.isOffline()) continue;
        const failure = normalizeFailure(error);
        if (!failure.transient) {
          const version = this.wakeVersion;
          this.patch({ phase: "blocked", stage: null, lastFailure: failure, retryAt: null });
          await this.waitForBlockedWake(version);
          this.patch({ attempt: 0, lastFailure: null });
          continue;
        }
        const attempt = this.stateValue.attempt + 1;
        const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
        const version = this.wakeVersion;
        this.patch({
          phase: "waiting",
          stage: null,
          attempt,
          lastFailure: failure,
          retryAt: Date.now() + delay,
        });
        const result = await this.waitForWakeOrTimeout(version, delay);
        if (
          result === "wakeup" &&
          (this.wakeReason === "application-active" || this.wakeReason === "explicit-retry")
        ) {
          this.patch({ attempt: 0 });
        }
      } finally {
        if (this.attemptController === controller) this.attemptController = undefined;
      }
    }
    this.releaseSession("Environment supervisor stopped");
    this.patch({ phase: "stopped", stage: null, retryAt: null });
  }

  private async monitorConnected(session: RpcSession): Promise<void> {
    while (this.stateValue.desired && this.sessionValue === session) {
      const version = this.wakeVersion;
      const result = await this.waitForWakeOrSessionClose(session, version);
      if (result.type === "closed") {
        this.sessionValue = null;
        throw normalizeFailure(result.error);
      }
      if (result.reason === "application-active") {
        try {
          await session.probe();
          continue;
        } catch (error) {
          this.releaseSession("Session probe failed");
          throw normalizeFailure(error);
        }
      }
      this.releaseSession("Environment connection refreshed");
      return;
    }
  }

  private releaseSession(reason: string): void {
    const session = this.sessionValue;
    this.sessionValue = null;
    session?.close(reason);
  }

  private isOffline(): boolean {
    return this.stateValue.network === "offline";
  }

  private wake(reason: RuntimeWakeup | "network" | "disconnect"): void {
    this.wakeReason = reason;
    this.wakeVersion += 1;
    const resolvers = [...this.wakeResolvers];
    this.wakeResolvers.clear();
    for (const resolve of resolvers) resolve();
  }

  private waitForWake(version: number): Promise<void> {
    if (version !== this.wakeVersion) return Promise.resolve();
    return new Promise((resolve) => {
      const resolver = () => {
        this.wakeResolvers.delete(resolver);
        resolve();
      };
      this.wakeResolvers.add(resolver);
    });
  }

  private async waitForBlockedWake(version: number): Promise<void> {
    let observedVersion = version;
    while (this.stateValue.desired) {
      await this.waitForWake(observedVersion);
      if (this.wakeReason !== "application-active") return;
      observedVersion = this.wakeVersion;
    }
  }

  private waitForWakeOrTimeout(version: number, milliseconds: number): Promise<"wakeup" | "timeout"> {
    if (version !== this.wakeVersion) return Promise.resolve("wakeup");
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const resolver = () => {
        if (timer !== undefined) clearTimeout(timer);
        this.wakeResolvers.delete(resolver);
        resolve("wakeup");
      };
      this.wakeResolvers.add(resolver);
      timer = setTimeout(() => {
        this.wakeResolvers.delete(resolver);
        resolve("timeout");
      }, milliseconds);
    });
  }

  private waitForWakeOrSessionClose(
    session: RpcSession,
    version: number,
  ): Promise<{ type: "closed"; error: Error } | { type: "wakeup"; reason: RuntimeWakeup | "network" | "disconnect" }> {
    if (version !== this.wakeVersion) {
      return Promise.resolve({ type: "wakeup", reason: this.wakeReason });
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: { type: "closed"; error: Error } | { type: "wakeup"; reason: RuntimeWakeup | "network" | "disconnect" }) => {
        if (settled) return;
        settled = true;
        this.wakeResolvers.delete(onWake);
        resolve(result);
      };
      const onWake = () => finish({ type: "wakeup", reason: this.wakeReason });
      this.wakeResolvers.add(onWake);
      void session.closed.then((error) => finish({ type: "closed", error }));
    });
  }

  private patch(patch: Partial<EnvironmentConnectionState>): void {
    this.stateValue = { ...this.stateValue, ...patch };
    for (const listener of this.listeners) listener(this.state, this.sessionValue);
  }
}

function normalizeFailure(error: unknown): ConnectionFailureType {
  if (error instanceof ConnectionFailure) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new ConnectionFailure("Connection attempt cancelled", "network", true, { cause: error });
  }
  return new ConnectionFailure(
    error instanceof Error ? error.message : "GitGui connection failed",
    "network",
    true,
    { cause: error },
  );
}

export { RETRY_DELAYS_MS, STABLE_CONNECTION_MS };
