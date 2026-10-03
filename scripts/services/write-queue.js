/**
 * Serialises asynchronous writes: one in flight at a time, FIFO. Pure JS.
 */
export class WriteQueue {
  #tail = Promise.resolve();
  #pending = 0;

  get pending() { return this.#pending; }

  /** Enqueue a function returning a promise; resolves with its result. */
  enqueue(fn) {
    this.#pending += 1;
    const run = this.#tail.then(() => fn()).finally(() => { this.#pending -= 1; });
    // Keep the chain alive even if a job rejects.
    this.#tail = run.catch(() => {});
    return run;
  }

  /** Resolves when everything queued so far has settled. */
  drain() {
    return this.#tail;
  }
}
