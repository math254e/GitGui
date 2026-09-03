import type { OrderedEventEnvelope } from "@gitgui/contracts";
import type { OrderedEventListener, TypedEventListener, Unsubscribe } from "./types";

export interface SequenceGap {
  expected: number;
  received: number;
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
    if (this.lastSequence !== undefined) {
      if (event.sequence <= this.lastSequence) return;
      if (event.sequence > this.lastSequence + 1) {
        const gap = { expected: this.lastSequence + 1, received: event.sequence };
        for (const listener of this.gapListeners) listener(gap);
      }
    }

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

  onSequenceGap(listener: SequenceGapListener): Unsubscribe {
    this.gapListeners.add(listener);
    return () => this.gapListeners.delete(listener);
  }
}
