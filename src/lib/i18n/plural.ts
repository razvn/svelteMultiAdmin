/**
 * Plural handling. Catalog arrays are ordered by the CLDR plural categories of the language
 * (`Intl.PluralRules(...).resolvedOptions().pluralCategories`, in the canonical order below), so an
 * English catalog has `[one, other]`, French `[one, many, other]`, Russian `[one, few, many, other]`.
 * gettext catalogs (.mo) are mapped onto these categories at import time (scripts/i18n/import-mo.ts).
 */

export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

export const CATEGORY_ORDER: readonly PluralCategory[] = [
	'zero',
	'one',
	'two',
	'few',
	'many',
	'other'
];

const rulesCache = new Map<string, Intl.PluralRules>();
const categoriesCache = new Map<string, readonly PluralCategory[]>();

function rules(intlLocale: string): Intl.PluralRules {
	let r = rulesCache.get(intlLocale);
	if (!r) {
		try {
			r = new Intl.PluralRules(intlLocale);
		} catch {
			r = new Intl.PluralRules('en');
		}
		rulesCache.set(intlLocale, r);
	}
	return r;
}

/** Plural categories of a language, canonical order. */
export function pluralCategories(intlLocale: string): readonly PluralCategory[] {
	let c = categoriesCache.get(intlLocale);
	if (!c) {
		const have = new Set(rules(intlLocale).resolvedOptions().pluralCategories as PluralCategory[]);
		c = CATEGORY_ORDER.filter((x) => have.has(x));
		categoriesCache.set(intlLocale, c);
	}
	return c;
}

/** Index into a plural array for `n`. */
export function pluralIndex(intlLocale: string, n: number): number {
	const cat = rules(intlLocale).select(n) as PluralCategory;
	const i = pluralCategories(intlLocale).indexOf(cat);
	return i < 0 ? pluralCategories(intlLocale).length - 1 : i;
}

/** English plural rule of the source strings: `tn(singular, plural, n)` -> singular when n is 1. */
export const sourceIsSingular = (n: number): boolean => n === 1;
