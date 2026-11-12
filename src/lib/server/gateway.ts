import type { RequestEvent } from '@sveltejs/kit';
import { IDENTITY_HEADERS, type AppId } from '#lib/server/apps.ts';
import { clientAddress } from '#lib/server/auth/cidr.ts';
import { getPortalConfig } from '#lib/server/config/schema.ts';
import { childPort, childState, redisServerNames } from '#lib/server/children.ts';
import { SESSION_COOKIE } from '#lib/server/session.ts';
import type { Principal } from '#lib/server/access.ts';

/** Hop-by-hop response headers a proxy must not pass on. */
const RESPONSE_HOP_BY_HOP = [
	'connection',
	'keep-alive',
	'transfer-encoding',
	'upgrade',
	'proxy-authenticate'
];

/**
 * Proxies one request to 127.0.0.1:<port of the app's child>. Strips client-supplied identity, forwarding and
 * hop-by-hop headers and the portal cookie; injects identity from the principal; streams both ways
 * (redirect: 'manual', duplex: 'half', accept-encoding: identity; every Set-Cookie kept).
 * 503 while the child is not healthy, 502 when it cannot be reached.
 */
export async function forward(
	event: Pick<RequestEvent, 'request' | 'url' | 'getClientAddress'>,
	app: AppId,
	principal: Principal,
	/** Proxies in front of the portal (trusted-header mode). Default: from the portal config. */
	trustedProxies?: readonly string[]
): Promise<Response> {
	const port = childPort(app);
	if (port === null || childState(app) !== 'healthy') {
		return new Response('Starting, try again in a moment.\n', {
			status: 503,
			headers: { 'retry-after': '2' }
		});
	}
	const { request, url } = event;
	// Behind an SSO proxy the TCP peer is the proxy: the real client is further along X-Forwarded-For.
	const auth = trustedProxies === undefined ? getPortalConfig().auth : null;
	const client = clientAddress(
		trustedProxies ?? (auth?.type === 'trusted-header' ? auth.trustedProxies : []),
		event.getClientAddress(),
		request.headers.get('x-forwarded-for')
	);
	const headers = upstreamHeaders(
		request.headers,
		app,
		principal,
		client ?? '',
		redisServerNames()
	);
	const hasBody = request.method !== 'GET' && request.method !== 'HEAD' && request.body !== null;
	let upstream: Response;
	try {
		upstream = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
			method: request.method,
			headers,
			body: hasBody ? request.body : null,
			// @ts-expect-error `duplex` is required by undici for streamed request bodies and absent from lib.dom
			duplex: 'half',
			redirect: 'manual',
			signal: request.signal
		});
	} catch {
		return new Response('Bad gateway.\n', { status: 502 });
	}
	const out = new Headers(upstream.headers);
	for (const name of RESPONSE_HOP_BY_HOP) out.delete(name);
	return new Response(upstream.status === 204 || upstream.status === 304 ? null : upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers: out
	});
}

/** Hop-by-hop headers (RFC 9110 7.6.1) plus `host`, which the upstream fetch sets itself. */
const HOP_BY_HOP = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'proxy-connection',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
	'host'
]);

/** Identity and forwarding headers a client (or an upstream proxy) could send to impersonate someone. */
const UNTRUSTED = new Set<string>([
	...Object.values(IDENTITY_HEADERS),
	'x-auth-request-user',
	'x-auth-request-email',
	'x-auth-request-groups',
	'x-auth-request-access-token',
	'x-auth-request-preferred-username',
	'forwarded',
	'x-real-ip',
	'x-original-forwarded-for',
	'x-forwarded-for',
	'x-forwarded-host',
	'x-forwarded-proto',
	'x-forwarded-port',
	'x-forwarded-prefix'
]);

function withoutPortalCookie(cookie: string): string {
	return cookie
		.split(';')
		.map((part) => part.trim())
		.filter((part) => part !== '' && !part.startsWith(`${SESSION_COOKIE}=`))
		.join('; ');
}

/** A group is forwarded as a comma separated list: drop any that would break or inject into it. */
const SAFE_GROUP = /^[^,\p{Cc}]+$/u;

/**
 * Pure, unit tested: the exact header set a child receives.
 *
 * Everything identity- or forwarding-related from the client is dropped first, then the identity is set
 * from the principal alone. Redis always gets its role (its "missing role means admin" default is never
 * reachable) and, unless the grant is 'all', the list of its server positions (possibly empty).
 * Groups are the principal's `kubeGroups` (empty for local users).
 *
 * @param redisServerNames server `name`s of the Redis child's `Servers`, in order: grants name servers,
 *   the child wants positions. A granted name the child does not have is ignored.
 * @throws when the principal has no grant for `app` (the caller gates first; this is the last line).
 */
export function upstreamHeaders(
	inbound: Headers,
	app: AppId,
	principal: Principal,
	clientAddress: string,
	redisServerNames: readonly string[] = []
): Headers {
	const out = new Headers();
	const connectionTokens = new Set(
		(inbound.get('connection') ?? '')
			.split(',')
			.map((t) => t.trim().toLowerCase())
			.filter(Boolean)
	);
	for (const [name, value] of inbound) {
		if (HOP_BY_HOP.has(name) || UNTRUSTED.has(name) || connectionTokens.has(name)) continue;
		if (name === 'cookie') {
			const kept = withoutPortalCookie(value);
			if (kept) out.set('cookie', kept);
			continue;
		}
		out.append(name, value);
	}

	out.set('accept-encoding', 'identity');
	out.set('x-forwarded-for', clientAddress);
	out.set(IDENTITY_HEADERS.user, principal.user);
	if (principal.email) out.set(IDENTITY_HEADERS.email, principal.email);
	const groups = principal.kubeGroups.filter((g) => SAFE_GROUP.test(g));
	if (groups.length > 0) out.set(IDENTITY_HEADERS.groups, groups.join(','));

	if (app === 'myadmin') {
		if (!principal.grants.myadmin) throw new Error('no myadmin grant');
	} else {
		const grant = principal.grants.redisadmin;
		if (!grant) throw new Error('no redisadmin grant');
		out.set(IDENTITY_HEADERS.role, grant.role);
		if (grant.servers !== 'all') {
			const positions = grant.servers
				.map((name) => redisServerNames.indexOf(name))
				.filter((index) => index >= 0);
			out.set(IDENTITY_HEADERS.servers, [...new Set(positions)].sort((a, b) => a - b).join(','));
		}
	}
	return out;
}
