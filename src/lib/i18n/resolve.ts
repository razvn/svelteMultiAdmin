/** Locale resolution. Pure functions: the server hook feeds them the request facts. */
import { DEFAULT_LANG, findLanguage } from './languages.ts';

export interface LocaleInputs {
	/** Value of the `sma_lang` cookie (explicit choice). */
	cookie?: string | null;
	/** `lang` user preference (Phase 8b). */
	pref?: unknown;
	/** Config `DefaultLang`. */
	defaultLang?: string | null;
	/** Raw `Accept-Language` header. */
	acceptLanguage?: string | null;
}

/** Map a language tag to one of the `available` codes, or null. `fr-CA` -> `fr`, `zh-HK` -> `zh-TW`. */
export function matchLanguage(tag: unknown, available: readonly string[]): string | null {
	if (typeof tag !== 'string') return null;
	const lang = findLanguage(tag);
	const pick = (code: string) =>
		available.find((a) => a.toLowerCase() === code.toLowerCase()) ?? null;
	if (lang) {
		const hit = pick(lang.code);
		if (hit) return hit;
	}
	const norm = tag.trim().replace(/_/g, '-').toLowerCase();
	if (!norm || norm === '*') return null;
	const [base] = norm.split('-');
	return pick(base);
}

/** Accept-Language tags by decreasing quality (stable for equal q), `q=0` dropped. */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
	if (!header) return [];
	return header
		.split(',')
		.map((part, index) => {
			const [tag, ...params] = part.trim().split(';');
			const q = params.map((p) => /^\s*q\s*=\s*([\d.]+)\s*$/i.exec(p)?.[1]).find((x) => x);
			return { tag: tag.trim(), q: q === undefined ? 1 : Number(q), index };
		})
		.filter((x) => x.tag && Number.isFinite(x.q) && x.q > 0)
		.sort((a, b) => b.q - a.q || a.index - b.index)
		.map((x) => x.tag);
}

/**
 * Order: explicit cookie -> user preference `lang` -> config `DefaultLang` -> Accept-Language -> `en`.
 *
 * `DefaultLang` defaults to `en` in the config schema, which cannot be told apart from "not set", so a
 * value of `en` does not short-circuit the Accept-Language negotiation (any other value does).
 */
export function resolveLocale(inputs: LocaleInputs, available: readonly string[]): string {
	const explicit = matchLanguage(inputs.cookie, available) ?? matchLanguage(inputs.pref, available);
	if (explicit) return explicit;
	const def = matchLanguage(inputs.defaultLang, available);
	if (def && def !== DEFAULT_LANG) return def;
	for (const tag of parseAcceptLanguage(inputs.acceptLanguage)) {
		const m = matchLanguage(tag, available);
		if (m) return m;
	}
	return def ?? DEFAULT_LANG;
}
