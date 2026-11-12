import { describe, expect, it } from 'vitest';
import { matchLanguage, parseAcceptLanguage, resolveLocale } from './resolve.ts';

const available = ['en', 'es', 'fr'];

describe('parseAcceptLanguage', () => {
	it('sorts by quality, drops q=0', () => {
		expect(parseAcceptLanguage('de;q=0.5, fr-CA, en;q=0.8, xx;q=0')).toEqual(['fr-CA', 'en', 'de']);
		expect(parseAcceptLanguage(null)).toEqual([]);
	});
});

describe('matchLanguage', () => {
	it('normalises case, underscores and regions', () => {
		expect(matchLanguage('FR', available)).toBe('fr');
		expect(matchLanguage('fr-CA', available)).toBe('fr');
		expect(matchLanguage('fr_FR', available)).toBe('fr');
		expect(matchLanguage('es-MX', available)).toBe('es');
		expect(matchLanguage('de', available)).toBeNull();
		expect(matchLanguage('*', available)).toBeNull();
		expect(matchLanguage(42, available)).toBeNull();
	});
});

describe('resolveLocale order', () => {
	it('cookie wins over everything', () => {
		expect(
			resolveLocale(
				{ cookie: 'es', pref: 'fr', defaultLang: 'fr', acceptLanguage: 'fr' },
				available
			)
		).toBe('es');
	});
	it('then the user preference', () => {
		expect(resolveLocale({ pref: 'fr', defaultLang: 'es', acceptLanguage: 'es' }, available)).toBe(
			'fr'
		);
	});
	it('then DefaultLang (when not the schema default en)', () => {
		expect(resolveLocale({ defaultLang: 'es', acceptLanguage: 'fr' }, available)).toBe('es');
	});
	it('then Accept-Language, so the default en does not shadow it', () => {
		expect(resolveLocale({ defaultLang: 'en', acceptLanguage: 'de, fr;q=0.9' }, available)).toBe(
			'fr'
		);
	});
	it('ignores unavailable values and ends with en', () => {
		expect(
			resolveLocale(
				{ cookie: 'xx', pref: 'de', defaultLang: 'it', acceptLanguage: 'ja' },
				available
			)
		).toBe('en');
		expect(resolveLocale({}, available)).toBe('en');
	});
});
