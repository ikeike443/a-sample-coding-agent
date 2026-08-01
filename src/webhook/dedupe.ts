export const DEFAULT_DEDUPE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_DEDUPE_MAX_ENTRIES = 10_000;

/**
 * In-memory TTL cache used to drop GitHub deliveries that are sent more than
 * once. Persisting delivery ids is left to the observability store.
 */
export class TtlCache {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly ttlMs: number = DEFAULT_DEDUPE_TTL_MS,
    private readonly now: () => number = Date.now,
    private readonly maxEntries: number = DEFAULT_DEDUPE_MAX_ENTRIES,
  ) {}

  /**
   * Returns true when the key was seen within the TTL window, otherwise
   * records it and returns false.
   */
  seen(key: string): boolean {
    const timestamp = this.now();
    this.prune(timestamp);

    const expiresAt = this.entries.get(key);
    if (expiresAt !== undefined && expiresAt > timestamp) {
      return true;
    }

    this.entries.set(key, timestamp + this.ttlMs);
    this.evictOldest();
    return false;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  /** Bounds memory usage when deliveries arrive faster than the TTL expires them. */
  private evictOldest(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.entries.delete(oldest.value);
    }
  }

  private prune(timestamp: number): void {
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= timestamp) {
        this.entries.delete(key);
      }
    }
  }
}
