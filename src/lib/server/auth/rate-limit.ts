/** Failed-login limiter: `max` failures per key within `windowMs` lock the key until the oldest ages out. */
export class LoginLimiter {
	private failures = new Map<string, number[]>();
	constructor(
		private max = 5,
		private windowMs = 5 * 60_000,
		private now: () => number = Date.now
	) {}

	private recent(key: string): number[] {
		const cutoff = this.now() - this.windowMs;
		const kept = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
		if (kept.length > 0) this.failures.set(key, kept);
		else this.failures.delete(key);
		return kept;
	}

	locked(key: string): boolean {
		return this.recent(key).length >= this.max;
	}

	fail(key: string): void {
		this.failures.set(key, [...this.recent(key), this.now()]);
	}

	clear(key: string): void {
		this.failures.delete(key);
	}
}
