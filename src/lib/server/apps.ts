/** The one list of bundled apps, and the identity-header contract shared with their config overlays. */

export const IDENTITY_HEADERS = {
	user: 'x-multiadmin-user',
	email: 'x-multiadmin-email',
	groups: 'x-multiadmin-groups',
	role: 'x-multiadmin-role',
	servers: 'x-multiadmin-servers'
} as const;

export const LOOPBACK = ['127.0.0.1/32', '::1/128'] as const;

export interface OverlayContext {
	portalUrl: URL;
	portalLabel: string;
	appId: AppId;
	/** HKDF(cookieSecret, appId) */
	derivedSecret: string;
}

interface AppSpec {
	label: string;
	childDir: string;
	port: number;
	configEnv: 'SMA_CONFIG' | 'SRA_CONFIG';
	/** Pure: operator's child config + portal facts -> the config the child is started with. */
	overlay: (childConfig: unknown, ctx: OverlayContext) => Record<string, unknown>;
}

/** The operator's child config cannot be turned into a valid bundled config. */
export class ConfigError extends Error {
	override name = 'ConfigError';
}

type Json = Record<string, unknown>;

function asObject(value: unknown, what: string): Json {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new ConfigError(`${what} must be a JSON object`);
	}
	return structuredClone(value) as Json;
}

function portalLink(ctx: OverlayContext): { url: string; label: string } {
	return { url: ctx.portalUrl.origin, label: ctx.portalLabel };
}

/** MyAdmin `Signon` block: trusted-header identity from IDENTITY_HEADERS; other Signon keys (authorize) kept. */
function signonFor(existing: unknown): Json {
	const signon = existing === undefined ? {} : asObject(existing, 'Signon');
	const identity =
		signon['identity'] === undefined ? {} : asObject(signon['identity'], 'Signon.identity');
	signon['identity'] = {
		...identity,
		type: 'trusted-header',
		userHeader: IDENTITY_HEADERS.user,
		emailHeader: IDENTITY_HEADERS.email,
		groupsHeader: IDENTITY_HEADERS.groups,
		trustedProxies: [...LOOPBACK]
	};
	return signon;
}

export function overlayMyAdmin(cfg: unknown, ctx: OverlayContext): Record<string, unknown> {
	const out = asObject(cfg, 'svelteMyAdmin config');
	const signonURL = `${ctx.portalUrl.origin}/go/myadmin`;
	const logoutURL = `${ctx.portalUrl.origin}/logout`;

	const servers = out['Servers'] ?? [];
	if (!Array.isArray(servers)) throw new ConfigError('Servers must be an array');
	out['Servers'] = servers.map((entry, i) => {
		const server = asObject(entry, `Servers[${i}]`);
		if (typeof server['user'] !== 'string' || server['user'] === '') {
			const name = server['verbose'] ?? server['host'] ?? i;
			throw new ConfigError(
				`Servers[${i}] (${String(name)}) needs an explicit "user": signon connects with the configured account`
			);
		}
		server['auth_type'] = 'signon';
		server['Signon'] = signonFor(server['Signon']);
		server['SignonURL'] = signonURL;
		server['LogoutURL'] = logoutURL;
		return server;
	});

	if (out['ServerDiscovery'] !== undefined) {
		const discovery = asObject(out['ServerDiscovery'], 'ServerDiscovery');
		const template =
			discovery['server'] === undefined
				? {}
				: asObject(discovery['server'], 'ServerDiscovery.server');
		template['Signon'] = signonFor(template['Signon']);
		template['SignonURL'] = signonURL;
		template['LogoutURL'] = logoutURL;
		discovery['server'] = template;
		out['ServerDiscovery'] = discovery;
	}

	// phpMyAdmin shape: proxy IP => header carrying the real client address (for AllowDeny and the audit log).
	out['TrustedProxies'] = { '127.0.0.1': 'X-Forwarded-For', '::1': 'X-Forwarded-For' };
	out['Portal'] = portalLink(ctx);
	return out;
}

export function overlayRedisAdmin(cfg: unknown, ctx: OverlayContext): Record<string, unknown> {
	const out = asObject(cfg, 'svelteRedisAdmin config');
	const previous = out['auth'] === undefined ? {} : asObject(out['auth'], 'auth');
	out['auth'] = {
		...previous,
		plugin: 'header',
		header: IDENTITY_HEADERS.user,
		headerGroups: IDENTITY_HEADERS.groups,
		headerRole: IDENTITY_HEADERS.role,
		headerServers: IDENTITY_HEADERS.servers,
		trustedProxies: [...LOOPBACK]
	};
	if (typeof out['cookieSecret'] !== 'string' || out['cookieSecret'] === '') {
		out['cookieSecret'] = ctx.derivedSecret;
	}
	out['Portal'] = portalLink(ctx);
	return out;
}

export const APPS = {
	myadmin: {
		label: 'MySQL',
		childDir: '/app/children/myadmin',
		port: 3101,
		configEnv: 'SMA_CONFIG',
		overlay: overlayMyAdmin
	},
	redisadmin: {
		label: 'Redis',
		childDir: '/app/children/redisadmin',
		port: 3102,
		configEnv: 'SRA_CONFIG',
		overlay: overlayRedisAdmin
	}
} as const satisfies Record<string, AppSpec>;

export type AppId = keyof typeof APPS;

export function parseAppId(value: string): AppId | null {
	return Object.hasOwn(APPS, value) ? (value as AppId) : null;
}
