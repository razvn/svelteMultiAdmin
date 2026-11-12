import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	finishOidc,
	identityFromClaims,
	startOidc,
	OIDC_FLOW_COOKIE,
	type OidcDeps
} from './oidc.ts';
import { parsePortalConfig } from '../config/schema.ts';
import { createSessionStore, SESSION_COOKIE } from '../session.ts';

const CLIENT_ID = 'multiadmin';
const PORTAL = 'http://portal.localhost:3000';

/** A tiny OIDC provider: discovery, JWKS, a token endpoint that enforces PKCE, single-use codes. */
async function fakeIdp() {
	const { publicKey, privateKey } = await generateKeyPair('RS256');
	const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
	const codes = new Map<
		string,
		{ nonce: string; challenge: string; redirect: string; claims: Record<string, unknown> }
	>();
	let issuer = '';
	const server: Server = createServer(async (req, res) => {
		const url = new URL(req.url ?? '/', issuer);
		const json = (body: unknown, status = 200) => {
			res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
		};
		if (url.pathname === '/.well-known/openid-configuration') {
			return json({
				issuer,
				authorization_endpoint: `${issuer}/authorize`,
				token_endpoint: `${issuer}/token`,
				jwks_uri: `${issuer}/jwks`,
				response_types_supported: ['code'],
				subject_types_supported: ['public'],
				id_token_signing_alg_values_supported: ['RS256'],
				code_challenge_methods_supported: ['S256']
			});
		}
		if (url.pathname === '/jwks') return json({ keys: [jwk] });
		if (url.pathname === '/token' && req.method === 'POST') {
			const chunks: Buffer[] = [];
			for await (const c of req) chunks.push(c as Buffer);
			const form = new URLSearchParams(Buffer.concat(chunks).toString());
			const entry = codes.get(form.get('code') ?? '');
			codes.delete(form.get('code') ?? ''); // single use
			const verifier = form.get('code_verifier') ?? '';
			const challenge = createHash('sha256').update(verifier).digest('base64url');
			if (!entry || entry.challenge !== challenge || entry.redirect !== form.get('redirect_uri')) {
				return json({ error: 'invalid_grant' }, 400);
			}
			const idToken = await new SignJWT({ nonce: entry.nonce, ...entry.claims })
				.setProtectedHeader({ alg: 'RS256', kid: 'k1' })
				.setIssuer(issuer)
				.setAudience(CLIENT_ID)
				.setIssuedAt()
				.setExpirationTime('5m')
				.sign(privateKey);
			return json({ access_token: 'at', token_type: 'Bearer', expires_in: 300, id_token: idToken });
		}
		json({ error: 'not_found' }, 404);
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		issuer,
		close: () => new Promise<void>((r) => server.close(() => r())),
		/** What the IdP does after the person authenticates: remember the request, hand back a code. */
		approve(authorizationUrl: URL, claims: Record<string, unknown>): string {
			const code = randomBytes(8).toString('hex');
			codes.set(code, {
				nonce: authorizationUrl.searchParams.get('nonce')!,
				challenge: authorizationUrl.searchParams.get('code_challenge')!,
				redirect: authorizationUrl.searchParams.get('redirect_uri')!,
				claims
			});
			return code;
		}
	};
}

describe('OIDC code flow', () => {
	let idp: Awaited<ReturnType<typeof fakeIdp>>;
	let deps: OidcDeps;
	const jar = new Map<string, string>();
	const event = (url = `${PORTAL}/auth/login`) =>
		({
			url: new URL(url),
			cookies: {
				get: (n: string) => jar.get(n),
				set: (n: string, v: string) => void jar.set(n, v),
				delete: (n: string) => void jar.delete(n)
			}
		}) as never;

	beforeAll(async () => {
		idp = await fakeIdp();
		const config = parsePortalConfig(
			{
				publicUrl: PORTAL,
				cookieSecret: 'x'.repeat(32),
				auth: {
					type: 'oidc',
					issuer: idp.issuer,
					clientId: CLIENT_ID,
					clientSecret: 's',
					allowInsecureIssuer: true
				},
				apps: {}
			},
			{ baseDir: '/c' }
		);
		deps = {
			config: () => config,
			sessions: (
				(s) => () =>
					s
			)(createSessionStore({ secret: 'x'.repeat(32), ttlSeconds: 600 }))
		};
	});
	afterAll(() => idp.close());

	const login = async (claims: Record<string, unknown>, tweak?: (callback: URL) => void) => {
		jar.clear();
		const auth = new URL(await startOidc(event(), '/go/redisadmin?rd=%2F', deps));
		const code = idp.approve(auth, claims);
		const callback = new URL(
			`${PORTAL}/auth/callback?code=${code}&state=${auth.searchParams.get('state')}`
		);
		tweak?.(callback);
		return { auth, result: await finishOidc(event(callback.href), deps) };
	};

	it('sends PKCE S256, state and nonce, and seals the flow in a cookie', async () => {
		jar.clear();
		const auth = new URL(await startOidc(event(), '/x', deps));
		expect(auth.origin).toBe(idp.issuer);
		expect(auth.pathname).toBe('/authorize');
		expect(Object.fromEntries(auth.searchParams)).toMatchObject({
			client_id: CLIENT_ID,
			response_type: 'code',
			redirect_uri: `${PORTAL}/auth/callback`,
			scope: 'openid profile email',
			code_challenge_method: 'S256'
		});
		for (const p of ['state', 'nonce', 'code_challenge'])
			expect(auth.searchParams.get(p)).toBeTruthy();
		expect(jar.get(OIDC_FLOW_COOKIE)).toBeTruthy();
		expect(jar.get(OIDC_FLOW_COOKIE)).not.toContain(auth.searchParams.get('state')); // sealed, not readable
	});

	it('signs in with the claims, opens a session, and returns to the saved path', async () => {
		const { result } = await login({
			sub: 'u-1',
			preferred_username: 'alice',
			email: 'alice@example.com',
			groups: ['devs', 'oidc:ops']
		});
		expect(result).toEqual({ ok: true, returnPath: '/go/redisadmin?rd=%2F' });
		const session = deps.sessions().fromCookie(jar.get(SESSION_COOKIE));
		expect(session?.identity).toEqual({
			source: 'oidc',
			user: 'alice',
			email: 'alice@example.com',
			groups: ['devs', 'oidc:ops'],
			kubeGroups: ['devs', 'oidc:ops']
		});
		expect(jar.has(OIDC_FLOW_COOKIE)).toBe(false);
	});

	it('refuses a wrong state, a replayed code, a missing flow cookie, and a tampered one', async () => {
		const wrong = await login({ sub: 'u' }, (cb) => cb.searchParams.set('state', 'nope'));
		expect(wrong.result.ok).toBe(false);
		expect(jar.has(SESSION_COOKIE)).toBe(false);

		jar.clear();
		const auth = new URL(await startOidc(event(), '/', deps));
		const cookie = jar.get(OIDC_FLOW_COOKIE)!;
		const code = idp.approve(auth, { sub: 'u' });
		const cb = `${PORTAL}/auth/callback?code=${code}&state=${auth.searchParams.get('state')}`;
		expect((await finishOidc(event(cb), deps)).ok).toBe(true);
		jar.set(OIDC_FLOW_COOKIE, cookie); // same flow again with the used code
		expect((await finishOidc(event(cb), deps)).ok).toBe(false);

		jar.clear();
		expect(await finishOidc(event(cb), deps)).toMatchObject({ ok: false, reason: /flow cookie/ });
		jar.set(OIDC_FLOW_COOKIE, cookie.slice(0, -3) + 'AAA');
		expect((await finishOidc(event(cb), deps)).ok).toBe(false);
	});

	it('refuses a token whose nonce does not match this flow', async () => {
		jar.clear();
		const a = new URL(await startOidc(event(), '/', deps));
		const other = new URL(a.href);
		other.searchParams.set('nonce', 'someone-elses');
		const code = idp.approve(other, { sub: 'u' });
		const result = await finishOidc(
			event(`${PORTAL}/auth/callback?code=${code}&state=${a.searchParams.get('state')}`),
			deps
		);
		expect(result.ok).toBe(false);
	});

	it('rejects an ID token with no usable user name', async () => {
		const { result } = await login({ sub: 'has,comma' });
		expect(result).toMatchObject({ ok: false, reason: /no usable user name/ });
	});
});

describe('identityFromClaims', () => {
	const auth = { groupsClaim: 'groups' };
	it('prefers preferred_username, then email, then sub', () => {
		expect(
			identityFromClaims({ sub: 's', email: 'e@x.io', preferred_username: 'p' }, auth)?.user
		).toBe('p');
		expect(identityFromClaims({ sub: 's', email: 'e@x.io' }, auth)?.user).toBe('e@x.io');
		expect(identityFromClaims({ sub: 's' }, auth)?.user).toBe('s');
		expect(identityFromClaims({ sub: 'a b' }, auth)).toBeNull();
	});
	it('drops unverified emails and unsafe groups, and reads a comma string or an array', () => {
		expect(
			identityFromClaims({ sub: 's', email: 'e@x.io', email_verified: false }, auth)?.email
		).toBeNull();
		const arr = identityFromClaims(
			{ sub: 's', groups: ['ok', 'a,b', 'x y', 'ok', 5, ' dev '] },
			auth
		);
		expect(arr?.groups).toEqual(['ok', 'dev']);
		expect(identityFromClaims({ sub: 's', groups: 'a, b' }, auth)?.groups).toEqual(['a', 'b']);
		expect(identityFromClaims({ sub: 's' }, { groupsClaim: 'roles' })?.groups).toEqual([]);
	});
});
