/**
 * The promise-based event bus the Svelte workspace layer consumes.
 *
 * It is not part of the vendored T3 Code runtime: T3 Code's React layer
 * consumes the Effect event stream directly.
 */
import type { OrderedEventEnvelope } from "@gitgui/contracts";

export type Unsubscribe = () => void;
export type OrderedEventListener = (event: OrderedEventEnvelope) => void;
export type TypedEventListener = (event: OrderedEventEnvelope) => void;

/** A hole in the server's event sequence. */
export interface SequenceGap {
  readonly expected: number;
  readonly received: number;
}

export type SequenceGapListener = (gap: SequenceGap) => void;

/** Dispatches ordered server events and reports missing sequence numbers. */
export class OrderedEventBus {
  private readonly orderedListeners = new Set<OrderedEventListener>();
  private readonly gapListeners = new Set<SequenceGapListener>();
  private readonly eventListeners = new Map<string, Set<TypedEventListener>>();
  private lastSequence?: number;

  get sequence(): number | undefined {
    return this.lastSequence;
  }

  accept(event: OrderedEventEnvelope): void {
    if (this.lastSequence !== undefined && event.sequence <= this.lastSequence) return;
    this.lastSequence = event.sequence;
    for (const listener of this.orderedListeners) listener(event);
    for (const listener of this.eventListeners.get(event.event) ?? []) listener(event);
  }

  reset(): void {
    this.lastSequence = undefined;
  }

  onEvent(listener: OrderedEventListener): Unsubscribe {
    this.orderedListeners.add(listener);
    return () => this.orderedListeners.delete(listener);
  }

  on(eventName: string, listener: TypedEventListener): Unsubscribe {
    const listeners = this.eventListeners.get(eventName) ?? new Set<TypedEventListener>();
    listeners.add(listener);
    this.eventListeners.set(eventName, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.eventListeners.delete(eventName);
    };
  }

  /**
   * Reports a hole in the server's event sequence.
   *
   * The transport watches the sequence, so the gap is found there and
   * reported here rather than guessed from the events that arrived.
   */
  reportGap(gap: SequenceGap): void {
    for (const listener of this.gapListeners) listener(gap);
  }

  onSequenceGap(listener: SequenceGapListener): Unsubscribe {
    this.gapListeners.add(listener);
    return () => this.gapListeners.delete(listener);
  }
}
