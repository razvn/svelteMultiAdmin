export type Params = Record<string, string | number | bigint>;

const PARAM = /\{(\w+)\}/g;

/** Replace `{name}` with `params.name`; unknown names are left untouched. */
export function interpolate(text: string, params?: Params): string {
	if (!params) return text;
	return text.replace(PARAM, (whole, name: string) =>
		Object.hasOwn(params, name) ? String(params[name]) : whole
	);
}

/** The `{name}` parameters of a message, as a sorted unique list. */
export function paramNames(text: string): string[] {
	return [...new Set([...text.matchAll(PARAM)].map((m) => m[1]))].sort();
}
