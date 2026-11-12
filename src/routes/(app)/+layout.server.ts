import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals, url }) => {
	const principal = locals.principal;
	if (!principal) redirect(303, `/login?rd=${encodeURIComponent(url.pathname + url.search)}`);
	return {
		me: { user: principal.user, email: principal.email, canAdminUsers: principal.grants.userAdmin }
	};
};
