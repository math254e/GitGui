import { GitGuiClientError } from "./errors";

export interface ReconnectSupervisorOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
}

export type ReconnectTask = (attempt: number, signal: AbortSignal) => Promise<void>;

export class ReconnectCancelledError extends GitGuiClientError {
  constructor() {
    super("Reconnect cancelled", { code: "reconnect_cancelled" });
    this.name = "ReconnectCancelledError";
  }
}

/** Explicit retry orchestration. Constructing this class never starts retries. */
export class ReconnectSupervisor {
  private readonly options: Required<ReconnectSupervisorOptions>;
  private controller?: AbortController;

  constructor(options: ReconnectSupervisorOptions = {}) {
    this.options = {
      initialDelayMs: options.initialDelayMs ?? 250,
      maxDelayMs: options.maxDelayMs ?? 10_000,
      maxAttempts: options.maxAttempts ?? 8,
    };
    if (
      !Number.isFinite(this.options.initialDelayMs)
      || !Number.isFinite(this.options.maxDelayMs)
      || this.options.initialDelayMs < 0
      || this.options.maxDelayMs < this.options.initialDelayMs
    ) {
      throw new RangeError("Reconnect delay bounds are invalid");
    }
    if (!Number.isInteger(this.options.maxAttempts) || this.options.maxAttempts <= 0) {
      throw new RangeError("maxAttempts must be a positive integer");
    }
  }

  get running(): boolean {
    return this.controller !== undefined;
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = undefined;
  }

  async run(task: ReconnectTask): Promise<void> {
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;

    try {
      for (let attempt = 0; attempt < this.options.maxAttempts; attempt += 1) {
        throwIfCancelled(controller.signal);
        try {
          await task(attempt, controller.signal);
          // A task may not observe the signal while it is awaiting I/O. Do not
          // report a cancelled run as a successful reconnect when it returns.
          throwIfCancelled(controller.signal);
          return;
        } catch (error) {
          if (controller.signal.aborted) throw new ReconnectCancelledError();
          if (attempt + 1 >= this.options.maxAttempts) throw error;
          await wait(calculateBackoffDelay(attempt, this.options), controller.signal);
        }
      }
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }
}

export function calculateBackoffDelay(attempt: number, options: Required<ReconnectSupervisorOptions>): number {
  if (!Number.isInteger(attempt) || attempt < 0) throw new RangeError("attempt must be a non-negative integer");
  return Math.min(options.maxDelayMs, options.initialDelayMs * 2 ** attempt);
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new ReconnectCancelledError();
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ReconnectCancelledError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ReconnectCancelledError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
