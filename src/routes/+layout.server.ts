import { availableLanguages, loadCatalog } from '#lib/i18n/catalog.ts';
import type { LayoutServerLoad } from './$types';

/** The resolved language for the whole tree, including the login page. */
export const load: LayoutServerLoad = async ({ locals }) => ({
	locale: locals.locale,
	languages: availableLanguages(),
	catalog: await loadCatalog(locals.locale)
});
