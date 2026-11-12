import type {} from './languages.ts';

export interface Language {
	/** Catalog folder name and cookie value (BCP 47 style: `fr`, `pt-BR`, `zh-CN`). */
	code: string;
	/** Name in the language itself. */
	native: string;
	/** English name. */
	english: string;
	dir: 'ltr' | 'rtl';
	/** Locale passed to `Intl.*` (number/date formatting, plural rules). */
	intl: string;
}

const l = (
	code: string,
	native: string,
	english: string,
	extra: Partial<Pick<Language, 'dir' | 'intl'>> = {}
): Language => ({ code, native, english, dir: 'ltr', intl: code, ...extra });

/**
 * Languages the app can speak. Which are actually *available* is decided by the catalog folders
 * under `locales/` (see `catalog.ts`): adding a language = add one line here + drop
 * `locales/<code>/<area>.json` with the translations.
 */
export const LANGUAGES: readonly Language[] = [
	l('en', 'English', 'English'),
	l('fr', 'Français', 'French'),
	l('es', 'Español', 'Spanish')
];

/** The source language: msgids are English, it never needs a catalog. */
export const SOURCE_LANG = 'en';
export const DEFAULT_LANG = 'en';

/** Cookie holding the explicit language choice. */
export const LANG_COOKIE = 'multiadmin_lang';

const byKey = new Map(LANGUAGES.map((x) => [x.code.toLowerCase(), x]));

/** `fr_CA` / `FR-ca` -> registry entry, or undefined. */
export function findLanguage(code: string | null | undefined): Language | undefined {
	if (!code) return undefined;
	return byKey.get(code.trim().replace(/_/g, '-').toLowerCase());
}

/** Registry entry for a code, English when unknown. */
export function languageInfo(code: string): Language {
	return findLanguage(code) ?? LANGUAGES[0];
}

/** Label for language selects: "Français (French)", "English". */
export function languageLabel(lang: Pick<Language, 'native' | 'english'>): string {
	return lang.native === lang.english ? lang.native : `${lang.native} (${lang.english})`;
}
