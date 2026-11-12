import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { localUsers } from '#lib/server/auth/index.ts';
import { LocalUserError } from '#lib/server/auth/local.ts';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.principal?.grants.userAdmin)
		error(403, locals.i18n.t('User administration is not allowed.'));
	const users = (await localUsers()).list();
	return {
		// An allowlist: the password hash must never reach the browser.
		users: users.map((u) => ({
			username: u.username,
			groups: u.groups,
			email: u.email,
			disabled: u.disabled
		})),
		me: locals.principal.user
	};
};

export const actions: Actions = {
	save: async ({ request, locals }) => {
		const t = locals.i18n.t;
		if (!locals.principal?.grants.userAdmin) error(403, t('User administration is not allowed.'));
		const form = await request.formData();
		const username = String(form.get('username') ?? '');
		try {
			await (
				await localUsers()
			).upsert({
				username,
				groups: String(form.get('groups') ?? '').split(','),
				email: String(form.get('email') ?? '') || null,
				disabled: form.get('disabled') === 'on',
				password: String(form.get('password') ?? '')
			});
		} catch (caught) {
			if (caught instanceof LocalUserError)
				return fail(400, { username, error: t(caught.message, caught.params) });
			throw caught;
		}
		return { saved: username.trim().toLowerCase() };
	},
	remove: async ({ request, locals }) => {
		const t = locals.i18n.t;
		if (!locals.principal?.grants.userAdmin) error(403, t('User administration is not allowed.'));
		const username = String((await request.formData()).get('username') ?? '');
		if (username.toLowerCase() === locals.principal.user) {
			return fail(400, { username, error: t('You cannot delete yourself.') });
		}
		await (await localUsers()).remove(username);
		return { removed: username };
	}
};
