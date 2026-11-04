// Upstream-derived request expiry, late resolve and stopped-service cases from
// T3 70cd258d DesktopSshPasswordPrompts / DesktopSshEnvironment tests.
import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
vi.mock("electron", () => ({ BrowserWindow: class {}, dialog: {}, ipcMain: {} }));
import { makePasswordPrompts, type PasswordPresenter } from "./DesktopSshPasswordPrompts.js";

async function fixture(timeoutMs = 180_000) {
  const scope = Scope.makeUnsafe("sequential");
  const presentations = new Map<string, (value: string | null) => void>();
  const closed: string[] = [];
  const presenter: PasswordPresenter = { present(id, _prompt, respond) { presentations.set(id, respond); return { close() { closed.push(id); } }; } };
  const service = await Effect.runPromise(makePasswordPrompts(presenter, timeoutMs).pipe(Effect.provideService(Scope.Scope, scope)));
  return { service, presentations, closed, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
}
describe("desktop SSH prompt scopes", () => {
  it("accepts one response, closes its presentation and ignores stale submissions", async () => {
    const f = await fixture();
    const request = Effect.runPromise(f.service.request("password"));
    await vi.waitFor(() => expect(f.presentations.size).toBe(1));
    const [id, respond] = [...f.presentations][0];
    respond("correct password"); respond("late password");
    expect(await request).toBe("correct password");
    expect(f.closed).toEqual([id]); await f.close();
  });
  it("expires an unanswered prompt, releases its window and rejects its late response", async () => {
    const f = await fixture(20);
    const request = expect(Effect.runPromise(f.service.request("password"))).rejects.toMatchObject({ category: "authentication" });
    await vi.waitFor(() => expect(f.presentations.size).toBe(1));
    await request;
    const [id, respond] = [...f.presentations][0]; respond("late secret");
    expect(f.closed).toEqual([id]); await f.close();
  });
  it("closes all pending prompts on service shutdown, including two independent requests", async () => {
    const f = await fixture();
    const first = expect(Effect.runPromise(f.service.request("first"))).rejects.toMatchObject({ category: "authentication" });
    const second = expect(Effect.runPromise(f.service.request("second"))).rejects.toMatchObject({ category: "authentication" });
    await vi.waitFor(() => expect(f.presentations.size).toBe(2));
    await f.close(); await Promise.all([first, second]);
    expect(new Set(f.closed)).toEqual(new Set(f.presentations.keys()));
    for (const respond of f.presentations.values()) respond("late secret");
  });
  it("interrupts one prompt scope without cancelling another request", async () => {
    const f = await fixture(); const abort = new AbortController();
    const first = Effect.runPromise(f.service.request("first"), { signal: abort.signal }).then(() => false, () => true);
    const second = Effect.runPromise(f.service.request("second"));
    await vi.waitFor(() => expect(f.presentations.size).toBe(2)); abort.abort();
    expect(await first).toBe(true);
    [...f.presentations.values()][1]("second-secret");
    expect(await second).toBe("second-secret"); expect(f.closed).toHaveLength(2); await f.close();
  });
  it("rejects requests after service disposal without opening a new presentation", async () => {
    const f = await fixture(); await f.close();
    await expect(Effect.runPromise(f.service.request("late request"))).rejects.toMatchObject({ category: "authentication" });
    expect(f.presentations.size).toBe(0);
  });
});
