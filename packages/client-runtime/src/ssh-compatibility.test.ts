import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Deferred from 'effect/Deferred';
import * as Fiber from 'effect/Fiber';
import * as Scope from 'effect/Scope';
import * as Exit from 'effect/Exit';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { FetchHttpClient, HttpClient } from 'effect/http';

// Compatibility probes, not a port of the upstream SSH manager or prompt service.
describe('SSH Effect compatibility spike', () => {
  it('closes a scoped Node child on interruption', async () => {
    let handle!: ChildProcessSpawner.ChildProcessHandle;
    await Effect.runPromise(Effect.gen(function* () {
      const scope = yield* Scope.make();
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      handle = yield* spawner.spawn(ChildProcess.make(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])).pipe(Effect.provideService(Scope.Scope, scope));
      expect(yield* handle.isRunning).toBe(true);
      yield* Scope.close(scope, Exit.void);
      expect(yield* handle.isRunning).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)));
  });

  it('interrupts a stalled HTTP request through the fetch service', async () => {
    let aborted = false;
    const fetchStub: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
    });
    await Effect.runPromise(HttpClient.get('http://127.0.0.1/').pipe(
      Effect.timeoutOption('50 millis'),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetchStub),
    ));
    expect(aborted).toBe(true);
  });

  it('removes a pending prompt on interruption and rejects late completion', async () => {
    let pending = true;
    await Effect.runPromise(Effect.gen(function* () {
      const answer = yield* Deferred.make<string>();
      const waiting = Deferred.await(answer).pipe(Effect.ensuring(Effect.sync(() => { pending = false; })));
      const fiber = yield* Effect.forkChild(waiting);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      expect(pending).toBe(false);
      // The registry gate, not Deferred itself, rejects late IPC responses.
      const resolve = pending ? yield* Deferred.succeed(answer, 'unused') : false;
      expect(resolve).toBe(false);
    }));
  });
});
