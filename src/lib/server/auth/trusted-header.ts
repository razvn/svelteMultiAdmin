import type { Identity } from '#lib/server/access.ts';
import type { AuthConfig } from '#lib/server/config/schema.ts';
import { peerMatcher } from '#lib/server/auth/cidr.ts';

type TrustedAuth = Extract<AuthConfig, { type: 'trusted-header' }>;

/** Same rule as OIDC: header-safe, no commas (a comma means the header arrived twice or would split a list). */
const SAFE = /^[^,\s\p{Cc}]{1,128}$/u;

const matchers = new WeakMap<readonly string[], (peer: string | null) => boolean>();

/**
 * The identity an SSO proxy (oauth2-proxy, an ingress auth-url, Pomerium...) put in the headers, only when the
 * direct TCP peer is one of `trustedProxies`: from anyone else the headers are ignored, because anyone can send
 * them. Read again on every request, so the proxy stays the only source of truth.
 */
export function identityFromHeaders(
	headers: Pick<Headers, 'get'>,
	peer: string | null,
	auth: TrustedAuth
): Identity | null {
	let trusted = matchers.get(auth.trustedProxies);
	if (!trusted) matchers.set(auth.trustedProxies, (trusted = peerMatcher(auth.trustedProxies)));
	if (!trusted(peer)) return null;

	const user = headers.get(auth.userHeader)?.trim();
	if (!user || !SAFE.test(user)) return null;
	const email = auth.emailHeader ? headers.get(auth.emailHeader)?.trim() : undefined;
	const groups = (auth.groupsHeader ? (headers.get(auth.groupsHeader) ?? '') : '')
		.split(',')
		.map((g) => g.trim())
		.filter((g) => SAFE.test(g));
	return {
		source: 'trusted-header',
		user,
		email: email && !/[\s,\p{Cc}]/u.test(email) ? email : null,
		groups: [...new Set(groups)],
		kubeGroups: [...new Set(groups)]
	};
}
