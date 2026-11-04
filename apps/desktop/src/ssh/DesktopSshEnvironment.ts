// Adapted from T3 Code 70cd258d8aac43ea57494527b00bf36de3efa6c0
// apps/desktop/src/ssh/DesktopSshEnvironment.ts. Promise conversion is confined to
// this Electron boundary; the manager, prompts, processes and cleanup use scopes.
// Keep historical opaque EnvironmentIds; only operation ownership IDs require UUIDs.
import { isValidEnvironmentId } from "@gitgui/contracts/environment";
import { randomUUID } from "node:crypto";
import type { DesktopPreparedConnection, DesktopCredential, DesktopSshCleanup, DesktopSshCleanupReport, DesktopSshHost, DesktopSshRequest, DesktopSshResult, DesktopSshTarget } from "@gitgui/contracts/desktop";
import { makeSshEnvironmentManager, nodeLayer, SshFailure, toSshFailure, type SshEnvironmentManager, type SshEnvironmentManagerOptions } from "@gitgui/ssh";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import { confirmHostTrust, makePasswordPrompts, nativePasswordPresenter } from "./DesktopSshPasswordPrompts.js";
import type { BrowserWindow } from "electron";

interface Owner { senderId: number; cancelled: boolean }
const invalid = () => new SshFailure({ category: "configuration", message: "Invalid SSH connection request." });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validateTarget(value: DesktopSshTarget): void {
  if (!value || typeof value !== "object" || value.kind !== "ssh" || typeof value.host !== "string" || value.host.length > 1024 || !value.host.trim() ||
    [value.user, value.identityFile, value.remoteDataDirectory].some(v => v !== undefined && (typeof v !== "string" || v.length > 4096 || /[\x00-\x1f]/.test(v))) ||
    (value.port !== undefined && (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535))) throw invalid();
}
export interface DesktopSshEnvironmentOptions extends Omit<SshEnvironmentManagerOptions, "requestPassword" | "requestHostTrust"> {
  readonly getParent: () => BrowserWindow | null;
  readonly makeManager?: typeof makeSshEnvironmentManager;
}
export class DesktopSshEnvironment {
  private readonly runtime = ManagedRuntime.make(nodeLayer);
  private readonly scope = Scope.makeUnsafe("sequential");
  private readonly manager: Promise<SshEnvironmentManager>;
  private readonly owners = new Map<string, Owner>();
  private closed = false;
  private closing?: Promise<void>;
  private disposed = false;
  private disposing?: Promise<void>;
  constructor(options: DesktopSshEnvironmentOptions) {
    this.manager = this.runtime.runPromise(Effect.gen(function* () {
      const prompts = yield* makePasswordPrompts(nativePasswordPresenter(options.getParent));
      return yield* (options.makeManager ?? makeSshEnvironmentManager)({ ...options,
        requestPassword: (_target, prompt) => prompts.request(prompt), requestHostTrust: request => confirmHostTrust(options.getParent, request),
      });
    }).pipe(Effect.provideService(Scope.Scope, this.scope)));
  }
  private bind(senderId: number, id: string, fresh = false): Owner {
    if (typeof id !== "string" || !UUID.test(id)) throw invalid();
    const existing = this.owners.get(id);
    if (existing && (existing.senderId !== senderId || fresh)) throw new SshFailure({ category: "cancelled", message: "This SSH operation has expired or belongs to another renderer." });
    if (existing) return existing;
    if (this.owners.size >= 8192) throw new SshFailure({ category: "configuration", message: "Too many SSH operations. Restart the desktop application." });
    const owner = { senderId, cancelled: false };
    this.owners.set(id, owner);
    return owner;
  }
  private async result<A>(operation: (manager: SshEnvironmentManager) => Effect.Effect<A, SshFailure>): Promise<DesktopSshResult<A>> {
    try {
      const manager = await this.manager;
      return await this.runtime.runPromise(operation(manager).pipe(Effect.match({
        onSuccess: value => ({ ok: true as const, value }), onFailure: error => ({ ok: false as const, error: { category: error.category, message: error.message } }),
      })));
    } catch (error) { const failure = toSshFailure(error); return { ok: false, error: { category: failure.category, message: failure.message } }; }
  }
  private rejected<A>(error: unknown): Promise<DesktopSshResult<A>> { const failure = toSshFailure(error); return Promise.resolve({ ok: false, error: { category: failure.category, message: failure.message } }); }
  discoverHosts(): Promise<DesktopSshResult<DesktopSshHost[]>> { return this.result(manager => manager.discoverHosts()); }
  ensureEnvironment(senderId: number, target: DesktopSshTarget, request: DesktopSshRequest = { operationId: randomUUID() }): Promise<DesktopSshResult<DesktopPreparedConnection>> {
    try {
      validateTarget(target);
      if (this.closed) throw new SshFailure({ category: "cancelled", message: "SSH connections are closed while the desktop is stopping." });
      if (!request || (request.expectedEnvironmentId !== undefined && !isValidEnvironmentId(request.expectedEnvironmentId))) throw invalid();
      const owner = this.bind(senderId, request.operationId, true);
      return this.result(manager => owner.cancelled || this.closed ? Effect.fail(new SshFailure({ category: "cancelled", message: "SSH operation was cancelled." })) : manager.ensureEnvironment(target, request));
    } catch (error) { return this.rejected(error); }
  }
  issuePairingCredential(senderId: number, id: string, expectedId: string): Promise<DesktopSshResult<DesktopCredential>> {
    try { this.requireOwner(senderId, id); return this.result(manager => manager.issuePairingCredential(id, expectedId)); } catch (error) { return this.rejected(error); }
  }
  claimConnection(senderId: number, id: string, expectedId: string): Promise<DesktopSshResult<void>> {
    try { this.requireOwner(senderId, id); return this.result(manager => manager.claimConnection(id, expectedId)); } catch (error) { return this.rejected(error); }
  }
  cancelConnection(senderId: number, id: string): Promise<DesktopSshResult<DesktopSshCleanup>> {
    try { this.bind(senderId, id).cancelled = true; return this.result(manager => manager.cancelConnection(id)); } catch (error) { return this.rejected(error); }
  }
  private requireOwner(senderId: number, id: string): void {
    const owner = this.owners.get(id);
    if (!owner || owner.senderId !== senderId || owner.cancelled) throw new SshFailure({ category: "cancelled", message: "This SSH operation is no longer active." });
  }
  disconnectEnvironment(target: DesktopSshTarget): Promise<DesktopSshResult<DesktopSshCleanupReport[]>> {
    try { validateTarget(target); return this.result(manager => manager.disconnectEnvironment(target)); } catch (error) { return this.rejected(error); }
  }
  close(): Promise<void> {
    this.closed = true;
    for (const owner of this.owners.values()) owner.cancelled = true;
    if (!this.closing) this.closing = this.manager.then(manager => this.runtime.runPromise(manager.close));
    return this.closing;
  }
  async reopen(): Promise<void> {
    if (this.disposed) throw new SshFailure({ category: "cancelled", message: "The SSH service has stopped." });
    await this.closing;
    const manager = await this.manager;
    await this.runtime.runPromise(manager.reopen);
    this.closing = undefined;
    this.closed = false;
  }
  async releaseSender(senderId: number): Promise<void> {
    const ids = [...this.owners].filter(([, owner]) => owner.senderId === senderId && !owner.cancelled).map(([id, owner]) => { owner.cancelled = true; return id; });
    await Promise.all(ids.map(id => this.result(manager => manager.cancelConnection(id))));
  }
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposed = true;
    this.disposing = (async () => {
      try { await this.close(); }
      finally {
        await this.runtime.runPromise(Scope.close(this.scope, Exit.void));
        await this.runtime.dispose();
      }
    })();
    return this.disposing;
  }
}
