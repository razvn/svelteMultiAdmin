import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { logout } from '#lib/server/auth/index.ts';
import { getPortalConfig } from '#lib/server/config/schema.ts';

// GET too: the children's "Log out" (LogoutURL) is a plain link.
const handler: RequestHandler = (event) => {
	logout(event);
	const auth = getPortalConfig().auth;
	if (auth.type === 'trusted-header' && auth.logoutUrl) {
		// The proxy's sign-out (e.g. /oauth2/sign_out), possibly on another origin: redirect() refuses those.
		return new Response(null, {
			status: 303,
			headers: { location: auth.logoutUrl, 'cache-control': 'no-store' }
		});
	}
	redirect(303, '/login');
};
export const GET = handler;
export const POST = handler;
