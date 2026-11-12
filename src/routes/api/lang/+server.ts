import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { availableCodes } from '#lib/i18n/catalog.ts';
import { LANG_COOKIE } from '#lib/i18n/languages.ts';
import { matchLanguage } from '#lib/i18n/resolve.ts';
import type { RequestHandler } from './$types';

const bodySchema = z.object({ lang: z.string().max(20) });

/**
 * Choose the interface language: remembered in the `multiadmin_lang` cookie. Public: the login
 * page uses it too.
 */
export const POST: RequestHandler = async ({ request, cookies, url }) => {
	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	const lang = parsed.success ? matchLanguage(parsed.data.lang, availableCodes()) : null;
	if (!lang) error(400, 'Unknown language');

	cookies.set(LANG_COOKIE, lang, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: url.protocol === 'https:',
		maxAge: 60 * 60 * 24 * 365
	});
	return Response.json({ lang });
};
