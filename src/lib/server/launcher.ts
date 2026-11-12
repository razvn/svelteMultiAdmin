import { APPS, type AppId } from '#lib/server/apps.ts';
import type { Principal } from '#lib/server/access.ts';
import type { PortalConfig } from '#lib/server/config/schema.ts';

export interface LauncherApp {
	id: AppId;
	label: string;
}

/** The apps this person may open: configured and granted. */
export function launchableApps(principal: Principal, config: PortalConfig): LauncherApp[] {
	return (Object.keys(APPS) as AppId[])
		.filter(
			(id) =>
				config.apps[id] &&
				(id === 'myadmin' ? principal.grants.myadmin : principal.grants.redisadmin !== null)
		)
		.map((id) => ({ id, label: config.apps[id]!.label }));
}
