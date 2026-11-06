/**
 * Adapted from T3 Code packages/client-runtime/src/connection/onboarding.ts
 * at 70cd258d8aac43ea57494527b00bf36de3efa6c0, independently of the runtime pin.
 * GitGui uses direct HTTP authentication, independent route IDs, a temporary
 * live Rust RPC preflight and disabled durable staging before host claim.
 * The acquisition finalizer spans all these stages, including persistence.
 * Existing-directory recovery pins the expected identity before authentication.
 * Optional labels follow T3 onboarding; legacy defaults use the remote host.
 */
import type { EnvironmentId, SshEnvironmentTarget } from "@gitgui/contracts/environment";
import { defaultEnvironmentName, environmentName } from "../environment/names.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SshEnvironmentGateway } from "../platform/capabilities.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { RpcSessionFactory } from "../rpc/session.ts";
import type { ConnectionPersistenceError } from "../platform/persistence.ts";
import { BearerConnectionCredential, SshConnectionProfile, SshConnectionRegistration } from "./catalog.ts";
import { ConnectionBlockedError, SshConnectionTarget, type ConnectionAttemptError } from "./model.ts";
import { EnvironmentRegistry } from "./registry.ts";
import { protocolCompatibilityError } from "./compatibility.ts";

export interface SshConnectionInput {
  readonly target: SshEnvironmentTarget;
  readonly label?: string;
  readonly expectedEnvironmentId?: EnvironmentId;
  readonly credential?: { readonly kind: string; readonly token: string };
}

export class ConnectionOnboarding extends Context.Service<ConnectionOnboarding, {
  readonly registerSsh: (input: SshConnectionInput) => Effect.Effect<EnvironmentId, ConnectionAttemptError | ConnectionPersistenceError>;
}>()("@gitgui/client-runtime/connection/onboarding/ConnectionOnboarding") {}

export const make = Effect.gen(function* () {
  const gateway = yield* SshEnvironmentGateway;
  const authorization = yield* RemoteEnvironmentAuthorization;
  const sessions = yield* RpcSessionFactory;
  const registry = yield* EnvironmentRegistry;

  const registerSsh = (input: SshConnectionInput) => Effect.scoped(Effect.gen(function* () {
    const chosenLabel = yield* Effect.try({
      try: () => input.label?.trim() ? environmentName(input.label) : undefined,
      catch: () => new ConnectionBlockedError({ reason: "configuration", detail: "Enter a valid environment name." }),
    });
    if (gateway.provision === undefined) {
      return yield* new ConnectionBlockedError({ reason: "unsupported", detail: "Recoverable SSH onboarding is unavailable." });
    }
    let accepted = false;
    const acquisition = yield* Effect.uninterruptibleMask((restore) =>
      restore(gateway.provision!(input.target, input.credential, input.expectedEnvironmentId)).pipe(Effect.tap((acquired) =>
        Effect.addFinalizer(() => accepted ? Effect.void : (acquired.cancel ?? Effect.void)),
      )),
    );
    const descriptor = acquisition.descriptor;
    if (descriptor === undefined || acquisition.commit === undefined) {
      return yield* new ConnectionBlockedError({ reason: "unsupported", detail: "The SSH service returned an incomplete acquisition." });
    }
    const incompatible = protocolCompatibilityError(descriptor);
    if (incompatible !== null) return yield* incompatible;
    const connectionId = `ssh:${crypto.randomUUID()}`;
    const label = chosenLabel ?? defaultEnvironmentName(descriptor.label, input.target.alias || input.target.hostname);
    const target = new SshConnectionTarget({ environmentId: descriptor.environmentId, label, connectionId });
    const authorized = yield* authorization.authorizeBearer({
      expectedEnvironmentId: descriptor.environmentId,
      httpBaseUrl: acquisition.bootstrap.httpBaseUrl,
      wsBaseUrl: acquisition.bootstrap.wsBaseUrl,
      bearerToken: acquisition.bearerToken,
      connectionMethod: "ssh",
    });
    // This temporary scope proves the normal authenticated welcome and initial
    // info exchange. The environment supervisor owns the subsequent live session.
    yield* Effect.scoped(Effect.gen(function* () {
      const session = yield* sessions.connect({ ...authorized, target, descriptor });
      yield* session.ready;
    }));
    const registration = new SshConnectionRegistration({
      target,
      profile: new SshConnectionProfile({ connectionId, environmentId: descriptor.environmentId,
        label, target: acquisition.target ?? input.target }),
      credential: new BearerConnectionCredential({ token: acquisition.bearerToken }),
    });
    const registered = yield* registry.register(registration, {
      beforeActivate: acquisition.commit,
      onCommitted: Effect.gen(function* () {
        if (acquisition.handoff !== undefined) yield* acquisition.handoff(connectionId);
        accepted = true;
      }),
    });
    if (!registered) return yield* new ConnectionBlockedError({ reason: "configuration", detail: "This environment is already managed by the platform." });
    return descriptor.environmentId;
  }));
  return ConnectionOnboarding.of({ registerSsh });
});

export const layer = Layer.effect(ConnectionOnboarding, make);
