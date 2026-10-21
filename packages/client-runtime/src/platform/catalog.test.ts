import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { EnvironmentId } from "@gitgui/contracts/environment";
import { BearerConnectionTarget, SshConnectionTarget } from "../connection/model.ts";
import { BearerConnectionCredential, BearerConnectionProfile, BearerConnectionRegistration, SshConnectionProfile, SshConnectionRegistration } from "../connection/catalog.ts";
import { makeTargetStore, makeRegistrationStore, makeProfileStore, type EnvironmentCatalogBackend } from "./catalog.ts";
import type { PersistedEnvironmentCatalog } from "./records.ts";

const environmentId = EnvironmentId.make("one");
const direct = new BearerConnectionRegistration({
  target: new BearerConnectionTarget({ environmentId, connectionId: "direct", label: "One" }),
  profile: new BearerConnectionProfile({ environmentId, connectionId: "direct", label: "One", httpBaseUrl: "https://one.test", wsBaseUrl: "wss://one.test" }),
  credential: new BearerConnectionCredential({ token: "test-bearer" }),
});

// Class methods deliberately use their receiver, like the real platform backends.
class Backend implements EnvironmentCatalogBackend {
  catalog: PersistedEnvironmentCatalog = { schemaVersion: 1, environments: [] };
  credentials = new Map<string, BearerConnectionCredential>();
  async read() { return this.catalog; }
  async write(catalog: PersistedEnvironmentCatalog) { this.catalog = catalog; }
  async readCredential(id: string) { return this.credentials.get(id); }
  async writeCredential(id: string, credential: BearerConnectionCredential) { this.credentials.set(id, credential); }
  async removeCredential(id: string) { this.credentials.delete(id); }
}

describe("platform connection persistence", () => {
  it.effect("keeps credentials out of records and restores class-backed targets and profiles", () => Effect.gen(function* () {
    const backend = new Backend();
    const registrations = yield* makeRegistrationStore(backend);
    yield* registrations.register(direct, [direct.target]);
    expect(JSON.stringify(backend.catalog)).not.toContain("test-bearer");
    expect(JSON.stringify(backend.catalog)).not.toContain('"credential"');
    expect(backend.credentials.get(environmentId)?.token).toBe("test-bearer");
    expect(yield* (yield* makeTargetStore(backend)).list).toEqual([direct.target]);
    const profiles = yield* makeProfileStore(backend);
    expect(Option.getOrUndefined(yield* profiles.get("direct"))).toEqual(direct.profile);
  }));

  it.effect("retains direct, SSH and learned profiles across reload, and prunes removed routes", () => Effect.gen(function* () {
    const backend = new Backend();
    const registrations = yield* makeRegistrationStore(backend);
    yield* registrations.register(direct, [direct.target]);
    const ssh = new SshConnectionRegistration({
      target: new SshConnectionTarget({ environmentId, connectionId: "ssh", label: "SSH" }),
      profile: new SshConnectionProfile({ environmentId, connectionId: "ssh", label: "SSH", target: { alias: "host", hostname: "host" } }),
      credential: direct.credential,
    });
    yield* registrations.register(ssh, [direct.target, ssh.target]);
    const profiles = yield* makeProfileStore(backend);
    const learned = new BearerConnectionProfile({ ...direct.profile, connectionId: "learned", learned: true });
    yield* profiles.put(learned);
    expect(Option.getOrUndefined(yield* profiles.get("learned"))).toEqual(learned);
    yield* registrations.setRoutes(environmentId, [direct.target, ssh.target, new BearerConnectionTarget({ ...direct.target, connectionId: "learned" })]);
    const reloaded = yield* makeProfileStore(backend);
    for (const id of ["direct", "ssh", "learned"]) expect(Option.isSome(yield* reloaded.get(id))).toBe(true);
    yield* registrations.setRoutes(environmentId, [ssh.target]);
    expect(Option.isNone(yield* reloaded.get("direct"))).toBe(true);
    expect(Option.isNone(yield* reloaded.get("learned"))).toBe(true);
  }));

  it.effect("serializes independent registrations and removes credentials with the record", () => Effect.gen(function* () {
    const backend = new Backend();
    const registrations = yield* makeRegistrationStore(backend);
    const second = new BearerConnectionRegistration({
      target: new BearerConnectionTarget({ ...direct.target, environmentId: EnvironmentId.make("two"), connectionId: "two" }),
      profile: new BearerConnectionProfile({ ...direct.profile, environmentId: EnvironmentId.make("two"), connectionId: "two" }),
      credential: direct.credential,
    });
    yield* Effect.all([
      registrations.register(direct, [direct.target]), registrations.register(second, [second.target]),
    ], { concurrency: "unbounded" });
    expect(backend.catalog.environments).toHaveLength(2);
    backend.catalog = { ...backend.catalog, selectedEnvironmentId: environmentId };
    yield* registrations.remove(environmentId);
    expect(backend.credentials.has(environmentId)).toBe(false);
    expect(backend.catalog.environments.map((record) => record.environmentId)).toEqual(["two"]);
    expect(backend.catalog).not.toHaveProperty("selectedEnvironmentId");
  }));

  it.effect("preserves the credential when removing its catalog record fails", () => Effect.gen(function* () {
    const backend = new Backend();
    const registrations = yield* makeRegistrationStore(backend);
    yield* registrations.register(direct, [direct.target]);
    backend.write = async () => { throw new Error("disk unavailable"); };
    expect((yield* registrations.remove(environmentId).pipe(Effect.flip))._tag).toBe("ConnectionPersistenceError");
    expect(backend.credentials.get(environmentId)).toEqual(direct.credential);
    expect(backend.catalog.environments).toHaveLength(1);
  }));

  it.effect("does not install a record if protected credential storage fails", () => Effect.gen(function* () {
    const backend = new Backend();
    backend.writeCredential = async () => { throw new Error("protected storage unavailable"); };
    const registrations = yield* makeRegistrationStore(backend);
    expect((yield* registrations.register(direct, [direct.target]).pipe(Effect.flip))._tag).toBe("ConnectionPersistenceError");
    expect(backend.catalog.environments).toEqual([]);
  }));
});
