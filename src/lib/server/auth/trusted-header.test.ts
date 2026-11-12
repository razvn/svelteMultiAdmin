import { describe, expect, it } from 'vitest';
import { clientAddress } from './cidr.ts';
import { authenticate, type AuthDeps } from './index.ts';
import { identityFromHeaders } from './trusted-header.ts';
import { parsePortalConfig } from '../config/schema.ts';

const config = parsePortalConfig(
	{
		publicUrl: 'https://admin.example.com',
		cookieSecret: 'x'.repeat(32),
		auth: {
			type: 'trusted-header',
			trustedProxies: ['10.42.0.0/16', '::1'],
			logoutUrl: '/oauth2/sign_out'
		},
		access: [{ match: { group: 'ops' }, grants: { myadmin: true } }],
		apps: {}
	},
	{ baseDir: '/c' }
);
const auth = config.auth as Extract<typeof config.auth, { type: 'trusted-header' }>;
const h = (init: Record<string, string>) => new Headers(init);

describe('identityFromHeaders', () => {
	const headers = h({
		'x-auth-request-user': 'alice',
		'x-auth-request-email': 'a@x.io',
		'x-auth-request-groups': 'ops, devs,ops'
	});
	it('reads the identity from a trusted peer', () => {
		expect(identityFromHeaders(headers, '10.42.3.4', auth)).toEqual({
			source: 'trusted-header',
			user: 'alice',
			email: 'a@x.io',
			groups: ['ops', 'devs'],
			kubeGroups: ['ops', 'devs']
		});
		expect(identityFromHeaders(headers, '::ffff:10.42.0.1', auth)?.user).toBe('alice'); // dual-stack peer
		expect(identityFromHeaders(headers, '::1', auth)?.user).toBe('alice');
	});
	it('ignores the headers from anyone else', () => {
		for (const peer of ['10.43.0.1', '203.0.113.7', '', null])
			expect(identityFromHeaders(headers, peer, auth)).toBeNull();
	});
	it('rejects a missing, doubled (comma) or control-character user', () => {
		for (const user of ['', ' ', 'alice,bob', 'al\tice', 'a b']) {
			expect(identityFromHeaders(h({ 'x-auth-request-user': user }), '10.42.0.1', auth)).toBeNull();
		}
		expect(identityFromHeaders(h({}), '10.42.0.1', auth)).toBeNull();
	});
	it('drops unsafe groups and a bad email', () => {
		const id = identityFromHeaders(
			h({
				'x-auth-request-user': 'u',
				'x-auth-request-groups': 'ok,a b,,x',
				'x-auth-request-email': 'no good'
			}),
			'10.42.0.1',
			auth
		);
		expect(id?.groups).toEqual(['ok', 'x']);
		expect(id?.email).toBeNull();
	});
});

describe('authenticate (trusted-header)', () => {
	const deps = { config: () => config } as AuthDeps;
	const event = (peer: string, headers: Record<string, string>) =>
		({
			request: new Request('https://admin.example.com/', { headers }),
			getClientAddress: () => peer,
			cookies: {},
			url: new URL('https://admin.example.com/')
		}) as never;
	it('builds a principal with grants and no session', async () => {
		const p = await authenticate(
			event('10.42.0.9', { 'x-auth-request-user': 'alice', 'x-auth-request-groups': 'ops' }),
			deps
		);
		expect(p).toMatchObject({
			user: 'alice',
			sid: null,
			grants: { myadmin: true, redisadmin: null, userAdmin: false }
		});
	});
	it('is anonymous without headers, and for a forged header from an untrusted peer', async () => {
		expect(await authenticate(event('10.42.0.9', {}), deps)).toBeNull();
		expect(
			await authenticate(event('198.51.100.1', { 'x-auth-request-user': 'root' }), deps)
		).toBeNull();
	});
});

describe('clientAddress', () => {
	const ranges = ['10.42.0.0/16'];
	it('walks X-Forwarded-For from the right while hops are trusted', () => {
		expect(clientAddress(ranges, '10.42.0.1', '203.0.113.7')).toBe('203.0.113.7');
		expect(clientAddress(ranges, '10.42.0.1', '6.6.6.6, 203.0.113.7, 10.42.0.5')).toBe(
			'203.0.113.7'
		);
	});
	it('ignores the header from an untrusted peer, and tolerates garbage', () => {
		expect(clientAddress(ranges, '198.51.100.1', '6.6.6.6')).toBe('198.51.100.1');
		expect(clientAddress(ranges, '10.42.0.1', 'garbage')).toBe('10.42.0.1');
		expect(clientAddress([], '::ffff:1.2.3.4', null)).toBe('1.2.3.4');
		expect(clientAddress(ranges, null, null)).toBeNull();
	});
});
