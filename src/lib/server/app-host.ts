import type { RequestEvent } from '@sveltejs/kit';
import { APPS, type AppId } from '#lib/server/apps.ts';
import type { Principal } from '#lib/server/access.ts';
import { authenticate } from '#lib/server/auth/index.ts';
import { getPortalConfig, type PortalConfig } from '#lib/server/config/schema.ts';
import { forward } from '#lib/server/gateway.ts';
import { safeReturnPath } from '#lib/server/return-path.ts';
import { ENTER_PATH, SESSION_COOKIE, sessions, type SessionStore } from '#lib/server/session.ts';

/** What the gate needs from the rest of the portal; tests replace it. */
export interface AppHostDeps {
	config: () => PortalConfig;
	sessions: () => SessionStore;
	authenticate: (event: RequestEvent) => Promise<Principal | null>;
	forward: (event: RequestEvent, app: AppId, principal: Principal) => Promise<Response>;
}

const defaults: AppHostDeps = { config: getPortalConfig, sessions, authenticate, forward };

/** The app served on this host (`host:port`, case-insensitive), or null for the portal and unknown hosts. */
export function appForHost(host: string, config: PortalConfig = getPortalConfig()): AppId | null {
	const wanted = host.toLowerCase();
	for (const id of Object.keys(config.apps) as AppId[]) {
		if (config.apps[id]!.publicUrl.host.toLowerCase() === wanted) return id;
	}
	return null;
}

export function granted(principal: Principal, app: AppId): boolean {
	return app === 'myadmin' ? principal.grants.myadmin : principal.grants.redisadmin !== null;
}

const redirect = (location: string, headers: Record<string, string> = {}) =>
	new Response(null, { status: 303, headers: { location, ...headers } });

/** The request's translator; plain English when the event has none (tests). */
type Translate = (msgid: string, params?: Record<string, string | number>) => string;
const translator = (event: RequestEvent): Translate =>
	event.locals?.i18n?.t ??
	((msgid, params) => msgid.replace(/\{(\w+)\}/g, (m, k) => String(params?.[k] ?? m)));

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(
	t: Translate,
	status: number,
	title: string,
	message: string,
	portal: string
): Response {
	return new Response(
		`<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
			`<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="${escapeHtml(portal)}">${escapeHtml(t('Back to the portal'))}</a></p>`,
		{ status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
	);
}

/**
 * Where the portal sends a signed-in person to open `app`: through a one-shot ticket (they get a cookie on the
 * app host), or straight to the path when there is no session of ours (trusted-header: the proxy covers every host).
 */
export function enterUrl(
	principal: Principal,
	app: AppId,
	returnPath: string,
	deps: Pick<AppHostDeps, 'config' | 'sessions'> = defaults
): string {
	const origin = deps.config().apps[app]!.publicUrl.origin;
	const rd = safeReturnPath(returnPath);
	if (principal.sid === null) return `${origin}${rd}`;
	const ticket = deps.sessions().issueTicket(principal.sid, app);
	return `${origin}${ENTER_PATH}?ticket=${encodeURIComponent(ticket)}&rd=${encodeURIComponent(rd)}`;
}

/** Portal URL that signs the person in (if needed) and sends them back into `app` at `path`. */
export function goUrl(config: PortalConfig, app: AppId, path: string): string {
	return `${config.publicUrl.origin}/go/${app}?rd=${encodeURIComponent(path)}`;
}

/**
 * Gate for an app host:
 * ENTER_PATH -> redeem the ticket -> set the host cookie -> 303 rd (a bad ticket gets a 403 page, never a loop).
 * no principal -> GET/HEAD: 303 to portal /go/<app>?rd ; otherwise 401.
 * principal without a grant -> 403 page linking back to the portal.
 * else gateway.forward (503 while the child starts).
 */
export async function serveAppHost(
	event: RequestEvent,
	app: AppId,
	deps: AppHostDeps = defaults
): Promise<Response> {
	const config = deps.config();
	const t = translator(event);
	const portal = config.publicUrl.origin;
	const { url, request } = event;
	const safeMethod = request.method === 'GET' || request.method === 'HEAD';

	if (url.pathname === ENTER_PATH) {
		if (!safeMethod) return new Response(t('Method not allowed.') + '\n', { status: 405 });
		const rd = safeReturnPath(url.searchParams.get('rd'));
		const store = deps.sessions();
		const sid = store.redeemTicket(url.searchParams.get('ticket') ?? '', app);
		const session = sid && store.get(sid);
		if (!session) {
			return page(
				t,
				403,
				t('Link expired'),
				t('This sign-in link is no longer valid.'),
				goUrl(config, app, rd)
			);
		}
		const secure = url.protocol === 'https:' ? '; Secure' : '';
		const maxAge = Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000));
		return redirect(rd, {
			'set-cookie': `${SESSION_COOKIE}=${store.cookieValue(session)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`,
			'cache-control': 'no-store'
		});
	}

	const principal = await deps.authenticate(event);
	if (!principal) {
		if (!safeMethod) return new Response(t('Authentication required.') + '\n', { status: 401 });
		return redirect(goUrl(config, app, url.pathname + url.search));
	}
	if (!granted(principal, app)) {
		return page(
			t,
			403,
			t('No access'),
			t('You do not have access to {app}.', { app: APPS[app].label }),
			portal
		);
	}
	return deps.forward(event, app, principal);
}
