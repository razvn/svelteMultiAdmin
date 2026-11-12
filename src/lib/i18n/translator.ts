// i18n-ignore-file (wrappers around the translation functions)
import { interpolate, type Params } from './interpolate.ts';
import { languageInfo } from './languages.ts';
import { pluralIndex, sourceIsSingular } from './plural.ts';

/** A catalog entry: a string, or the plural forms in CLDR order for `tn()`. */
export type Message = string | string[];
/** Flat gettext-like catalog: msgid -> translation. Context entries use `"context\u0004msgid"`. */
export type Catalog = Record<string, Message>;

/** gettext's separator between msgctxt and msgid. */
export const CONTEXT_SEPARATOR = '\u0004';
export const contextKey = (context: string, msgid: string) =>
	`${context}${CONTEXT_SEPARATOR}${msgid}`;

/**
 * Immutable translation functions for one language. English text is the key; a missing or empty
 * translation falls back to the English source. All members are arrow properties so they can be
 * destructured: `const { t, tn, tc } = useI18n()`.
 */
export class Translator {
	readonly locale: string;
	readonly intl: string;
	readonly catalog: Catalog;

	constructor(locale = 'en', catalog: Catalog = {}) {
		this.locale = locale;
		this.intl = languageInfo(locale).intl;
		this.catalog = catalog;
	}

	#text(key: string): string | undefined {
		const m = Object.hasOwn(this.catalog, key) ? this.catalog[key] : undefined;
		return typeof m === 'string' && m !== '' ? m : undefined;
	}

	/** Translate `msgid`, interpolating `{name}` params. */
	t = (msgid: string, params?: Params): string => interpolate(this.#text(msgid) ?? msgid, params);

	/** Translate with a gettext context (msgctxt) that disambiguates identical English strings. */
	tc = (context: string, msgid: string, params?: Params): string =>
		interpolate(this.#text(contextKey(context, msgid)) ?? msgid, params);

	/**
	 * Plural: `singular` is the catalog key, `plural` the English plural. `{n}` is available in the
	 * text in addition to `params`.
	 */
	tn = (singular: string, plural: string, n: number, params?: Params): string => {
		const all: Params = params && Object.hasOwn(params, 'n') ? params : { n, ...params };
		const m = Object.hasOwn(this.catalog, singular) ? this.catalog[singular] : undefined;
		if (Array.isArray(m) && m.length > 0) {
			const form = m[Math.min(pluralIndex(this.intl, n), m.length - 1)];
			if (form) return interpolate(form, all);
		}
		return interpolate(sourceIsSingular(n) ? singular : plural, all);
	};
}

/** English (source) translator without a catalog: always safe to share. */
export const SOURCE_TRANSLATOR = new Translator('en');

/** Merge catalogs (later wins) into one flat object. */
export function mergeCatalogs(parts: readonly Catalog[]): Catalog {
	return Object.assign({}, ...parts) as Catalog;
}

/** Marks a string for extraction without translating it (gettext's `N_`); translate it later with `t()`. */
export const N_ = <T extends string>(msgid: T): T => msgid;
