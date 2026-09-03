import { GitGuiClient } from "../rpc/client";
import type { PreparedConnection, RpcSession } from "./model";
import { ConnectionFailure } from "./model";
import { EXPECTED_PROTOCOL_VERSION } from "./resolver";

export class RpcSessionFactory {
  async open(connection: PreparedConnection, signal: AbortSignal): Promise<RpcSession> {
    if (signal.aborted) throw abortFailure();
    const client = new GitGuiClient({
      endpoint: connection.httpUrl,
      expectedProtocolVersion: EXPECTED_PROTOCOL_VERSION,
      ...(connection.websocketTicket ? { webSocketTicket: connection.websocketTicket } : {}),
    });

    let resolveClosed!: (error: Error) => void;
    const closed = new Promise<Error>((resolve) => { resolveClosed = resolve; });
    let connected = false;
    const unsubscribe = client.onStateChange(({ current, error }) => {
      if (current === "ready") connected = true;
      else if (connected && current !== "connecting" && current !== "reconnecting") {
        resolveClosed(error ?? new ConnectionFailure("GitGui session closed", "network", true));
      }
    });
    const abort = () => client.disconnect("Connection attempt cancelled");
    signal.addEventListener("abort", abort, { once: true });
    try {
      const welcome = await client.connect();
      if (signal.aborted) throw abortFailure();
      if (welcome.environment_id !== connection.descriptor.environmentId) {
        throw new ConnectionFailure("The WebSocket connected to a different GitGui environment", "configuration", false);
      }
    } catch (error) {
      unsubscribe();
      client.disconnect("Connection attempt failed");
      if (error instanceof ConnectionFailure) throw error;
      throw new ConnectionFailure("Could not open the GitGui RPC session", "network", true, { cause: error });
    } finally {
      signal.removeEventListener("abort", abort);
    }

    return {
      client,
      descriptor: connection.descriptor,
      ready: Promise.resolve(),
      closed,
      async probe(probeSignal?: AbortSignal) {
        if (probeSignal?.aborted) throw abortFailure();
        await client.getServerStatus();
      },
      close(reason = "GitGui session closed") {
        unsubscribe();
        client.disconnect(reason);
        resolveClosed(new ConnectionFailure(reason, "network", true));
      },
    };
  }
}

function abortFailure() {
  return new ConnectionFailure("Connection attempt cancelled", "network", true);
}
