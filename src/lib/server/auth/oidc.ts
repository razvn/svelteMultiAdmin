import type { RequestEvent } from '@sveltejs/kit';
import * as client from 'openid-client';
import type { Identity } from '#lib/server/access.ts';
import { seal, unseal } from '#lib/server/auth/seal.ts';
import { getPortalConfig, type AuthConfig, type PortalConfig } from '#lib/server/config/schema.ts';
import { safeReturnPath } from '#lib/server/return-path.ts';
import { SESSION_COOKIE, sessions, type SessionStore } from '#lib/server/session.ts';

type OidcAuth = Extract<AuthConfig, { type: 'oidc' }>;
type CookieEvent = Pick<RequestEvent, 'cookies' | 'url'>;

export const OIDC_FLOW_COOKIE = 'multiadmin_oidc';
export const CALLBACK_PATH = '/auth/callback';
const FLOW_TTL_SECONDS = 600;

export interface OidcDeps {
	config: () => PortalConfig;
	sessions: () => SessionStore;
}
const defaults: OidcDeps = { config: getPortalConfig, sessions };

interface Flow {
	state: string;
	nonce: string;
	verifier: string;
	rd: string;
}

const discovered = new Map<string, Promise<client.Configuration>>();

/** Discovery document + client, once per issuer (a failed discovery is retried on the next login). */
function discover(auth: OidcAuth): Promise<client.Configuration> {
	const key = `${auth.issuer.href}|${auth.clientId}`;
	let pending = discovered.get(key);
	if (!pending) {
		pending = client.discovery(
			auth.issuer,
			auth.clientId,
			auth.clientSecret,
			undefined,
			auth.allowInsecureIssuer ? { execute: [client.allowInsecureRequests] } : undefined
		);
		pending.catch(() => discovered.delete(key));
		discovered.set(key, pending);
	}
	return pending;
}

function oidcAuth(config: PortalConfig): OidcAuth {
	if (config.auth.type !== 'oidc') throw new Error('oidc auth is not configured');
	return config.auth;
}

const redirectUri = (config: PortalConfig) => `${config.publicUrl.origin}${CALLBACK_PATH}`;

/** Stable, header-safe: no control characters, whitespace or commas (a comma would split a groups header). */
const SAFE = /^[^,\s\p{Cc}]{1,128}$/u;

const str = (value: unknown): string | null =>
	typeof value === 'string' && value !== '' ? value : null;

/** Pure: ID token claims -> Identity, or null when no usable user name can be derived. */
export function identityFromClaims(
	claims: Record<string, unknown>,
	auth: Pick<OidcAuth, 'groupsClaim'>
): Identity | null {
	const user = [str(claims['preferred_username']), str(claims['email']), str(claims['sub'])].find(
		(candidate) => candidate !== null && SAFE.test(candidate)
	);
	if (!user) return null;
	const email = str(claims['email']);
	const raw = claims[auth.groupsClaim];
	const listed = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
	const groups = [
		...new Set(listed.filter((g): g is string => typeof g === 'string').map((g) => g.trim()))
	].filter((g) => SAFE.test(g));
	return {
		source: 'oidc',
		user,
		email:
			email && claims['email_verified'] !== false && !/[\s,\p{Cc}]/u.test(email) ? email : null,
		groups,
		kubeGroups: groups
	};
}

/** Starts the code flow (PKCE + state + nonce, sealed in a short cookie). Returns the IdP URL to send the browser to. */
export async function startOidc(
	event: CookieEvent,
	returnPath: string,
	deps: OidcDeps = defaults
): Promise<string> {
	const config = deps.config();
	const auth = oidcAuth(config);
	const flow: Flow = {
		state: client.randomState(),
		nonce: client.randomNonce(),
		verifier: client.randomPKCECodeVerifier(),
		rd: safeReturnPath(returnPath)
	};
	event.cookies.set(OIDC_FLOW_COOKIE, seal(config.cookieSecret, 'oidc-flow', flow), {
		path: CALLBACK_PATH,
		httpOnly: true,
		sameSite: 'lax', // the IdP returns on a cross-site top-level GET
		secure: event.url.protocol === 'https:',
		maxAge: FLOW_TTL_SECONDS
	});
	const url = client.buildAuthorizationUrl(await discover(auth), {
		redirect_uri: redirectUri(config),
		scope: auth.scopes.join(' '),
		state: flow.state,
		nonce: flow.nonce,
		code_challenge: await client.calculatePKCECodeChallenge(flow.verifier),
		code_challenge_method: 'S256'
	});
	return url.href;
}

export type OidcResult = { ok: true; returnPath: string } | { ok: false; reason: string };

/**
 * Completes the flow on the callback: checks state, nonce, PKCE and the ID token, builds the identity from its
 * claims, opens a session and sets the cookie. The reason of a failure is for the log, never for the page.
 */
export async function finishOidc(
	event: CookieEvent,
	deps: OidcDeps = defaults
): Promise<OidcResult> {
	const config = deps.config();
	const auth = oidcAuth(config);
	const flow = unseal<Flow>(config.cookieSecret, 'oidc-flow', event.cookies.get(OIDC_FLOW_COOKIE));
	event.cookies.delete(OIDC_FLOW_COOKIE, { path: CALLBACK_PATH });
	if (!flow) return { ok: false, reason: 'missing or invalid flow cookie' };
	try {
		// The redirect_uri registered at the IdP is the public one; the request URL may differ behind a proxy.
		const current = new URL(redirectUri(config));
		current.search = event.url.search;
		const tokens = await client.authorizationCodeGrant(await discover(auth), current, {
			pkceCodeVerifier: flow.verifier,
			expectedState: flow.state,
			expectedNonce: flow.nonce,
			idTokenExpected: true
		});
		const claims = tokens.claims();
		const identity = claims && identityFromClaims(claims as Record<string, unknown>, auth);
		if (!identity) return { ok: false, reason: 'no usable user name in the ID token' };
		const store = deps.sessions();
		const session = store.create(identity);
		event.cookies.set(SESSION_COOKIE, store.cookieValue(session), {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: event.url.protocol === 'https:',
			maxAge: config.sessionTtlSeconds
		});
		return { ok: true, returnPath: flow.rd };
	} catch (caught) {
		return { ok: false, reason: (caught as Error).message };
	}
}
