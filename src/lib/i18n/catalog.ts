/**
 * Catalog discovery and lazy loading. Catalogs live in `locales/<lang>/<area>.json`; every area file of a
 * language is merged into one flat catalog. Bundlers split each file into its own chunk, so a client
 * only downloads the active language. The English source needs no catalog.
 */
import { LANGUAGES, SOURCE_LANG, type Language } from './languages.ts';
import { mergeCatalogs, Translator, type Catalog } from './translator.ts';

const files = import.meta.glob<Catalog>('./locales/*/*.json', { import: 'default' });

const loaders = new Map<string, Array<() => Promise<Catalog>>>();
for (const [path, load] of Object.entries(files)) {
	const lang = /^\.\/locales\/([^/]+)\//.exec(path)?.[1];
	if (!lang) continue;
	(loaders.get(lang) ?? loaders.set(lang, []).get(lang)!).push(load);
}

/** Registry languages that have at least one catalog file, plus the English source. */
export function availableLanguages(): Language[] {
	return LANGUAGES.filter((l) => l.code === SOURCE_LANG || loaders.has(l.code));
}

export const availableCodes = (): string[] => availableLanguages().map((l) => l.code);

// Immutable data (not per-user state), safe to share between requests.
const cache = new Map<string, Promise<Catalog>>();

/** Merged catalog of a language ({} for the source language and for unknown ones). */
export function loadCatalog(lang: string): Promise<Catalog> {
	if (lang === SOURCE_LANG || !loaders.has(lang)) return Promise.resolve({});
	let p = cache.get(lang);
	if (!p) {
		p = Promise.all(loaders.get(lang)!.map((load) => load())).then(mergeCatalogs);
		p.catch(() => cache.delete(lang));
		cache.set(lang, p);
	}
	return p;
}

export async function loadTranslator(lang: string): Promise<Translator> {
	return new Translator(lang, await loadCatalog(lang));
}
