import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { parseAppId } from '#lib/server/apps.ts';
import { enterUrl, granted } from '#lib/server/app-host.ts';
import { getPortalConfig } from '#lib/server/config/schema.ts';
import { safeReturnPath } from '#lib/server/return-path.ts';

export const GET: RequestHandler = ({ params, url, locals }) => {
	const app = parseAppId(params.app) ?? error(404);
	if (!getPortalConfig().apps[app]) error(404);
	if (!locals.principal)
		redirect(303, `/login?rd=${encodeURIComponent(url.pathname + url.search)}`);
	if (!granted(locals.principal, app))
		error(403, locals.i18n.t('You do not have access to this application.'));
	// Deliberately cross-origin (the app's own host): SvelteKit's redirect() refuses external locations.
	const location = enterUrl(locals.principal, app, safeReturnPath(url.searchParams.get('rd')));
	return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
};
