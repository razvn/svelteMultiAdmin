import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { loginLocal } from '#lib/server/auth/index.ts';
import { getPortalConfig } from '#lib/server/config/schema.ts';
import { safeReturnPath } from '#lib/server/return-path.ts';

export const load: PageServerLoad = ({ locals, url }) => {
	if (locals.principal) redirect(303, safeReturnPath(url.searchParams.get('rd')));
	if (getPortalConfig().auth.type === 'trusted-header') {
		error(401, locals.i18n.t('Authentication required: sign in through your organization proxy.'));
	}
	return { authType: getPortalConfig().auth.type, rd: safeReturnPath(url.searchParams.get('rd')) };
};

export const actions: Actions = {
	default: async (event) => {
		const t = event.locals.i18n.t;
		const form = await event.request.formData();
		const username = String(form.get('username') ?? '');
		const password = String(form.get('password') ?? '');
		const result = await loginLocal(event, username, password);
		if (result === 'locked')
			return fail(429, { username, error: t('Too many attempts. Try again in a few minutes.') });
		if (result === 'invalid')
			return fail(400, { username, error: t('Wrong username or password.') });
		redirect(303, safeReturnPath(event.url.searchParams.get('rd')));
	}
};
