// Release selection for the vendored child apps. Pure, so it is unit tested without git.

export interface Semver {
	major: number;
	minor: number;
	patch: number;
	/** Dot separated pre-release identifiers, empty for a release. */
	pre: string[];
}

/** `v1.2.3` or `v1.2.3-rc.1` (the leading `v` is required: other tags are not releases). */
export function parseTag(tag: string): Semver | null {
	const m = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(tag);
	if (!m) return null;
	return { major: +m[1]!, minor: +m[2]!, patch: +m[3]!, pre: m[4] ? m[4].split('.') : [] };
}

/** SemVer precedence: numeric parts, then a release beats its pre-releases, then identifiers one by one. */
export function compareSemver(a: Semver, b: Semver): number {
	for (const key of ['major', 'minor', 'patch'] as const) {
		if (a[key] !== b[key]) return a[key] - b[key];
	}
	if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length;
	for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
		const x = a.pre[i];
		const y = b.pre[i];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		if (x === y) continue;
		const xn = /^\d+$/.test(x);
		const yn = /^\d+$/.test(y);
		if (xn && yn) return Number(x) - Number(y);
		if (xn !== yn) return xn ? -1 : 1;
		return x < y ? -1 : 1;
	}
	return 0;
}

/** The highest release tag. Pre-releases are only considered when no release exists and `allowPrerelease` is set. */
export function pickLatest(tags: readonly string[], allowPrerelease = false): string | null {
	const parsed = tags.flatMap((tag) => {
		const v = parseTag(tag);
		return v ? [{ tag, v }] : [];
	});
	const releases = parsed.filter((p) => p.v.pre.length === 0);
	const pool = releases.length > 0 || !allowPrerelease ? releases : parsed;
	pool.sort((x, y) => compareSemver(y.v, x.v));
	return pool[0]?.tag ?? null;
}
