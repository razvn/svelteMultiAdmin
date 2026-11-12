import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getPortalConfig } from '#lib/server/config/schema.ts';
import { launchableApps } from '#lib/server/launcher.ts';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.principal) redirect(303, '/login');
	return { apps: launchableApps(locals.principal, getPortalConfig()) };
};
