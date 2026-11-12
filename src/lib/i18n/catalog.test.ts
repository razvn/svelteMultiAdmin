import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { availableCodes, loadCatalog, loadTranslator } from './catalog.ts';
import { makeFmt } from './context.svelte.ts';

describe('catalogs', () => {
	it('discovers languages from the locales folder', () => {
		expect(availableCodes()).toEqual(expect.arrayContaining(['en', 'fr', 'es']));
		expect(availableCodes()).not.toContain('de');
	});
	it('merges all area files of a language', async () => {
		const fr = await loadCatalog('fr');
		expect(fr['Sign in']).toBe('Connexion'); // login
		expect(fr['Applications']).toBe('Applications'); // app
		expect(fr['Log out']).toBe('Se déconnecter'); // app
	});
	it('English and unknown languages have an empty catalog', async () => {
		expect(await loadCatalog('en')).toEqual({});
		expect(await loadCatalog('xx')).toEqual({});
	});
	it('translates through a loaded translator, with parameters', async () => {
		const es = await loadTranslator('es');
		expect(es.t('Password')).toBe('Contraseña');
		expect(es.t('Saved {name}.', { name: 'amy' })).toBe('amy guardado.');
		expect(es.t('Not in any catalog')).toBe('Not in any catalog');
	});
	it('formats numbers and dates for the locale', async () => {
		const fmt = makeFmt(await loadTranslator('fr'));
		expect(fmt.number(1234.5)).toBe('1 234,5'.replace(' ', ' '));
	});
});

/** Every `t('msgid')` literal of the source, plus the msgids the domain layer throws for the screens to translate. */
function sourceMsgids(): Map<string, string> {
	const found = new Map<string, string>();
	const pattern =
		/\bt\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")|LocalUserError\(\s*'((?:[^'\\]|\\.)*)'/g;
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) {
				if (!['ui', 'testing', 'locales'].includes(name)) walk(path);
			} else if (
				/\.(svelte|ts)$/.test(name) &&
				!name.endsWith('.test.ts') &&
				!path.includes('/lib/i18n/')
			) {
				for (const m of readFileSync(path, 'utf8').matchAll(pattern)) {
					found.set((m[1] ?? m[2] ?? m[3]!).replace(/\\'/g, "'"), path);
				}
			}
		}
	};
	walk(new URL('../..', import.meta.url).pathname);
	// Strings of the language menu live under lib/i18n/ (excluded above).
	for (const id of ['Change language', 'Language'])
		found.set(id, 'components/i18n/language-menu.svelte');
	return found;
}

describe('translations are complete', () => {
	const ids = sourceMsgids();
	it('finds the strings of the source', () => {
		expect(ids.size).toBeGreaterThan(50);
		expect(ids.has('Sign in')).toBe(true);
	});
	for (const lang of ['fr', 'es']) {
		it(`${lang} translates every msgid of the source`, async () => {
			const catalog = await loadCatalog(lang);
			const missing = [...ids]
				.filter(([id]) => !catalog[id])
				.map(([id, file]) => `${id}  (${file})`);
			expect(missing).toEqual([]);
		});
		it(`${lang} has no msgid the source no longer uses, and keeps every {param}`, async () => {
			const catalog = await loadCatalog(lang);
			const stale = Object.keys(catalog).filter((id) => !ids.has(id));
			expect(stale).toEqual([]);
			for (const [id, text] of Object.entries(catalog)) {
				const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
				expect(params(text as string), id).toEqual(params(id));
			}
		});
	}
});
