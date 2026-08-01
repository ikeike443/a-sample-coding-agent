export const DEFAULT_DEDUPE_TTL_MS = 10 * 60 * 1000;

/**
 * In-memory TTL cache used to drop GitHub deliveries that are sent more than
 * once. Persisting delivery ids is left to the observability store.
 */
export class TtlCache {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly ttlMs: number = DEFAULT_DEDUPE_TTL_MS,
    private readonly now: () => number = Date.now,
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
    return false;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  private prune(timestamp: number): void {
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= timestamp) {
        this.entries.delete(key);
      }
    }
  }
}
