import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { finishOidc } from '#lib/server/auth/oidc.ts';
import { getPortalConfig } from '#lib/server/config/schema.ts';

export const GET: RequestHandler = async (event) => {
	if (getPortalConfig().auth.type !== 'oidc') error(404);
	const result = await finishOidc(event);
	if (!result.ok) {
		console.error('[oidc] sign-in refused:', result.reason);
		error(400, event.locals.i18n.t('Sign-in failed. Go back and try again.'));
	}
	redirect(303, result.returnPath);
};
