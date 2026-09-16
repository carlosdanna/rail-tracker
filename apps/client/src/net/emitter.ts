/** A minimal typed event emitter: no dependencies, no `any`. */
export type Listener<T> = (payload: T) => void;

/**
 * Emitter over an event map, e.g.
 * `new Emitter<{ open: void; batch: Batch }>()`.
 */
export class Emitter<Events extends Record<string, unknown>> {
  readonly #listeners = new Map<keyof Events, Set<Listener<never>>>();

  /** Subscribes to an event and returns an unsubscribe function. */
  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  /** Subscribes to the next occurrence only. */
  once<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    const off = this.on(event, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  /** Delivers an event to every current listener. */
  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    // Copy first so a listener may unsubscribe during dispatch.
    for (const fn of [...set]) {
      (fn as Listener<Events[K]>)(payload);
    }
  }

  /** Drops every listener, for one event or for all of them. */
  off<K extends keyof Events>(event?: K): void {
    if (event === undefined) this.#listeners.clear();
    else this.#listeners.delete(event);
  }
}
