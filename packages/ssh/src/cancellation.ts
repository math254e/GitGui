/**
 * Adapts T3 packages/ssh/src/tunnel.ts scope cancellation and bounded probes,
 * plus DesktopSshPasswordPrompts.ts's bounded wait, at
 * 70cd258d8aac43ea57494527b00bf36de3efa6c0 to GitGui's Promise manager.
 * Abort signals replace Effect interruption; each wait removes its listener.
 */
export async function abortable<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([cancelled, Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    })]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function withDeadline<T>(signal: AbortSignal, timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error("SSH operation timed out")), timeoutMs);
  try {
    const combined = AbortSignal.any([signal, deadline.signal]);
    return await abortable(combined, () => operation(combined));
  } finally {
    clearTimeout(timer);
    deadline.abort();
  }
}
