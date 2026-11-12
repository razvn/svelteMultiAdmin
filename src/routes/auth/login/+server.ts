import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { startOidc } from '#lib/server/auth/oidc.ts';
import { getPortalConfig } from '#lib/server/config/schema.ts';

export const GET: RequestHandler = async (event) => {
	if (getPortalConfig().auth.type !== 'oidc') error(404);
	let location: string;
	try {
		location = await startOidc(event, event.url.searchParams.get('rd') ?? '/');
	} catch (caught) {
		console.error('[oidc] cannot start the sign-in:', (caught as Error).message);
		error(503, event.locals.i18n.t('The identity provider is not reachable right now.'));
	}
	// Cross-origin on purpose: SvelteKit's redirect() refuses external locations.
	return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
};
