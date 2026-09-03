import type { ConnectionRegistration, ConnectionStage, RpcSession } from "./model";
import { ConnectionResolver } from "./resolver";
import { RpcSessionFactory } from "./session";

export class ConnectionDriver {
  constructor(
    private readonly resolver: ConnectionResolver,
    private readonly sessions = new RpcSessionFactory(),
  ) {}

  async connect(
    registration: ConnectionRegistration,
    signal: AbortSignal,
    onStage: (stage: ConnectionStage) => void,
  ): Promise<RpcSession> {
    onStage("resolving");
    const prepared = await this.resolver.resolve(registration, signal);
    onStage("opening");
    const session = await this.sessions.open(prepared, signal);
    onStage("synchronizing");
    await session.ready;
    return session;
  }
}
