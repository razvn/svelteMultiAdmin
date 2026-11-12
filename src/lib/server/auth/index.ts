import type { RequestEvent } from '@sveltejs/kit';
import { grantsFor, type Identity, type Principal } from '#lib/server/access.ts';
import { getPortalConfig, type PortalConfig } from '#lib/server/config/schema.ts';
import { identityFromHeaders } from '#lib/server/auth/trusted-header.ts';
import { LoginLimiter } from '#lib/server/auth/rate-limit.ts';
import { openLocalUserStore, type LocalUser, type LocalUserStore } from '#lib/server/auth/local.ts';
import { SESSION_COOKIE, sessions, type SessionStore } from '#lib/server/session.ts';

/** What auth needs from the rest of the portal; tests replace it. */
export interface AuthDeps {
	config: () => PortalConfig;
	sessions: () => SessionStore;
	users: () => Promise<LocalUserStore>;
	limiter: LoginLimiter;
}

let usersOnce: Promise<LocalUserStore> | undefined;

/** The local user store of the configured `local` auth, opened once. */
export function localUsers(): Promise<LocalUserStore> {
	const auth = getPortalConfig().auth;
	if (auth.type !== 'local') throw new Error('local auth is not configured');
	usersOnce ??= openLocalUserStore(auth.usersFile, auth.bootstrapAdmin);
	return usersOnce;
}

const defaults: AuthDeps = {
	config: getPortalConfig,
	sessions,
	users: localUsers,
	limiter: new LoginLimiter()
};

type CookieEvent = Pick<RequestEvent, 'cookies' | 'url'>;
type AuthEvent = CookieEvent & Pick<RequestEvent, 'request' | 'getClientAddress'>;

export function localIdentity(user: LocalUser): Identity {
	// kubeGroups stays empty: a local admin must not be able to mint a Kubernetes group like system:masters.
	return {
		source: 'local',
		user: user.username,
		email: user.email,
		groups: user.groups,
		kubeGroups: []
	};
}

/**
 * The person behind a request, on the portal host and app hosts alike, with grants recomputed now.
 * `local`/`oidc`: the session cookie; a local user is re-read on every call, so disabling or regrouping
 * them takes effect on their next click. `trusted-header` has no session of ours: the proxy's headers are read each time.
 */
export async function authenticate(
	event: AuthEvent,
	deps: AuthDeps = defaults
): Promise<Principal | null> {
	const config = deps.config();
	if (config.auth.type === 'trusted-header') {
		let peer: string | null;
		try {
			peer = event.getClientAddress();
		} catch {
			peer = null;
		}
		const identity = identityFromHeaders(event.request.headers, peer, config.auth);
		return identity && { ...identity, grants: grantsFor(identity, config.access), sid: null };
	}
	const store = deps.sessions();
	const session = store.fromCookie(event.cookies.get(SESSION_COOKIE));
	if (!session) return null;
	let identity = session.identity;
	if (identity.source === 'local') {
		const user = (await deps.users()).get(identity.user);
		if (!user || user.disabled) {
			store.revoke(session.sid);
			return null;
		}
		identity = localIdentity(user);
	}
	return { ...identity, grants: grantsFor(identity, config.access), sid: session.sid };
}

export type LoginResult = 'ok' | 'invalid' | 'locked';

/** Local login. On `ok` the session cookie is set. Failures are limited per username. */
export async function loginLocal(
	event: CookieEvent,
	username: string,
	password: string,
	deps: AuthDeps = defaults
): Promise<LoginResult> {
	const config = deps.config();
	if (config.auth.type !== 'local') return 'invalid';
	const key = username.trim().toLowerCase();
	if (deps.limiter.locked(key)) return 'locked';
	const user = await (await deps.users()).verify(username, password);
	if (!user) {
		deps.limiter.fail(key);
		return 'invalid';
	}
	deps.limiter.clear(key);
	const store = deps.sessions();
	const session = store.create(localIdentity(user));
	event.cookies.set(SESSION_COOKIE, store.cookieValue(session), {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: event.url.protocol === 'https:',
		maxAge: config.sessionTtlSeconds
	});
	return 'ok';
}

/** Ends the session everywhere (one table, every host's cookie dies with it). */
export function logout(event: CookieEvent, deps: Pick<AuthDeps, 'sessions'> = defaults): void {
	const store = deps.sessions();
	const session = store.fromCookie(event.cookies.get(SESSION_COOKIE));
	if (session) store.revoke(session.sid);
	event.cookies.delete(SESSION_COOKIE, { path: '/' });
}
