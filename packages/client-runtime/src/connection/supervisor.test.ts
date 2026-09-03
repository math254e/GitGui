import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitGuiClient } from "../rpc/client";
import type { ConnectionDriver } from "./driver";
import {
  ConnectionFailure,
  type ConnectionPlatform,
  type ConnectionRegistration,
  type RpcSession,
  type RuntimeWakeup,
} from "./model";
import { EnvironmentSupervisor, RETRY_DELAYS_MS } from "./supervisor";

const registration: ConnectionRegistration = {
  environmentId: "00000000-0000-4000-8000-000000000001",
  displayName: "Test environment",
  target: { kind: "bearer", httpUrl: "https://example.test" },
  capabilities: [],
  protocolVersion: 2,
};

afterEach(() => vi.useRealTimers());

describe("EnvironmentSupervisor", () => {
  it("waits offline without attempting and connects when the network returns", async () => {
    const platform = makePlatform(false);
    const session = makeSession();
    const connect = vi.fn().mockResolvedValue(session.value);
    const supervisor = new EnvironmentSupervisor(registration, { connect } as unknown as ConnectionDriver, platform.value);

    supervisor.connect();
    await flush();
    expect(supervisor.state.phase).toBe("offline");
    expect(connect).not.toHaveBeenCalled();

    platform.setOnline(true);
    await flush();
    expect(supervisor.state.phase).toBe("connected");
    expect(connect).toHaveBeenCalledTimes(1);
    await supervisor.disconnect();
  });

  it("retries transient failures forever and caps the delay", async () => {
    vi.useFakeTimers();
    const platform = makePlatform(true);
    const connect = vi.fn().mockRejectedValue(new ConnectionFailure("offline", "network", true));
    const supervisor = new EnvironmentSupervisor(registration, { connect } as unknown as ConnectionDriver, platform.value);
    supervisor.connect();
    await flush();

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      expect(supervisor.state.phase).toBe("waiting");
      expect(supervisor.state.attempt).toBe(attempt);
      const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
      expect(supervisor.state.retryAt).toBe(Date.now() + delay);
      await vi.advanceTimersByTimeAsync(delay);
      await flush();
    }
    expect(connect).toHaveBeenCalledTimes(7);
    await supervisor.disconnect();
  });

  it("keeps blocked failures asleep until credentials or explicit retry change", async () => {
    const platform = makePlatform(true);
    const connect = vi.fn().mockRejectedValue(new ConnectionFailure("pairing required", "authentication", false));
    const supervisor = new EnvironmentSupervisor(registration, { connect } as unknown as ConnectionDriver, platform.value);
    supervisor.connect();
    await flush();
    expect(supervisor.state.phase).toBe("blocked");

    platform.wake("application-active");
    await flush();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(supervisor.state.phase).toBe("blocked");

    supervisor.credentialChanged();
    await flush();
    expect(connect).toHaveBeenCalledTimes(2);
    await supervisor.disconnect();
  });

  it("replaces an involuntarily closed session and advances generation", async () => {
    vi.useFakeTimers();
    const platform = makePlatform(true);
    const first = makeSession();
    const second = makeSession();
    const connect = vi.fn().mockResolvedValueOnce(first.value).mockResolvedValueOnce(second.value);
    const supervisor = new EnvironmentSupervisor(registration, { connect } as unknown as ConnectionDriver, platform.value);
    supervisor.connect();
    await flush();
    expect(supervisor.state.generation).toBe(1);

    first.closeFromTransport(new ConnectionFailure("socket closed", "network", true));
    await flush();
    expect(supervisor.state.phase).toBe("waiting");
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
    await flush();
    expect(supervisor.state.phase).toBe("connected");
    expect(supervisor.state.generation).toBe(2);
    expect(connect).toHaveBeenCalledTimes(2);
    await supervisor.disconnect();
  });
});

function makePlatform(initiallyOnline: boolean) {
  let online = initiallyOnline;
  const networkListeners = new Set<(online: boolean) => void>();
  const wakeListeners = new Set<(reason: RuntimeWakeup) => void>();
  const value: ConnectionPlatform = {
    isOnline: () => online,
    subscribeNetwork(listener) {
      networkListeners.add(listener);
      return () => networkListeners.delete(listener);
    },
    subscribeWakeups(listener) {
      wakeListeners.add(listener);
      return () => wakeListeners.delete(listener);
    },
    async getPrimaryConnection() { return null; },
    async ensureSshConnection() { throw new Error("not used"); },
  };
  return {
    value,
    setOnline(next: boolean) {
      online = next;
      for (const listener of networkListeners) listener(next);
    },
    wake(reason: RuntimeWakeup) {
      for (const listener of wakeListeners) listener(reason);
    },
  };
}

function makeSession() {
  let resolveClosed!: (error: Error) => void;
  const closed = new Promise<Error>((resolve) => (resolveClosed = resolve));
  const value: RpcSession = {
    client: {} as GitGuiClient,
    descriptor: {} as RpcSession["descriptor"],
    ready: Promise.resolve(),
    closed,
    probe: vi.fn().mockResolvedValue(undefined),
    close: vi.fn((reason?: string) => resolveClosed(new Error(reason ?? "closed"))),
  };
  return { value, closeFromTransport: resolveClosed };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
