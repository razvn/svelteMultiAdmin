import type { RequestEvent } from '@sveltejs/kit';
import { availableCodes, loadTranslator } from '#lib/i18n/catalog.ts';
import { LANG_COOKIE, languageInfo } from '#lib/i18n/languages.ts';
import { resolveLocale } from '#lib/i18n/resolve.ts';

type LocaleEvent = Pick<RequestEvent, 'cookies' | 'request' | 'locals'>;

/**
 * Resolve the language of a request (cookie -> Accept-Language -> en) and set
 * `locals.locale` / `locals.i18n`.
 */
export async function applyLocale(event: LocaleEvent): Promise<void> {
	const locale = resolveLocale(
		{
			cookie: event.cookies.get(LANG_COOKIE),
			acceptLanguage: event.request.headers.get('accept-language')
		},
		availableCodes()
	);
	if (event.locals.i18n && event.locals.locale === locale) return;
	event.locals.locale = locale;
	event.locals.i18n = await loadTranslator(locale);
}

/** `%lang%` / `%dir%` placeholders of app.html. */
export function fillHtmlLang(html: string, locale: string): string {
	const info = languageInfo(locale);
	return html.replace('%lang%', info.code).replace('%dir%', info.dir);
}
