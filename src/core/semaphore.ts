/**
 * A counting semaphore. `run` starts work immediately while slots are free and
 * queues the rest, so a fan-out (parallel subagents, for example) can be capped
 * without serialising it. `acquire` / `release` are exposed for holders that
 * span an `await` inside an async generator, where a callback would hide the
 * yields; always release in a `finally`.
 */
export class Semaphore {
  readonly limit: number
  private available: number
  private readonly waiting: Array<() => void> = []

  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit))
    this.available = this.limit
  }

  /** Run `task` with a slot held for its whole lifetime. */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await task()
    } finally {
      this.release()
    }
  }

  /** Takes the next free slot, queueing until one is released. */
  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1
      return
    }
    await new Promise<void>((resolve) => {
      this.waiting.push(resolve)
    })
  }

  /** Returns a slot, handing it straight to the first waiter when there is one. */
  release(): void {
    const next = this.waiting.shift()
    if (next === undefined) this.available += 1
    else next()
  }
}
