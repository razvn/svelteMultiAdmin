import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	ConfigError,
	IDENTITY_HEADERS,
	LOOPBACK,
	overlayMyAdmin,
	overlayRedisAdmin,
	parseAppId
} from './apps.ts';
import type { OverlayContext } from './apps.ts';

const ctx = (appId: OverlayContext['appId']): OverlayContext => ({
	portalUrl: new URL('https://admin.example.com/ignored'),
	portalLabel: 'Admin portal',
	appId,
	derivedSecret: 'derived-secret-derived-secret-1234'
});

const sample = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const MYADMIN_SAMPLE = '/Users/raz/dev/perso/svelte/svelteMyAdmin/svelteMyAdmin/config.sample.json';
const REDIS_SAMPLE = '/Users/raz/dev/perso/svelte/svelteRedisAdmin/config.sample.json';

describe('overlayRedisAdmin', () => {
	it('switches the sample to the header plugin on loopback', () => {
		const out = overlayRedisAdmin(sample(REDIS_SAMPLE), ctx('redisadmin')) as Record<string, any>;
		expect(out.auth).toMatchObject({
			plugin: 'header',
			header: IDENTITY_HEADERS.user,
			headerGroups: IDENTITY_HEADERS.groups,
			headerRole: IDENTITY_HEADERS.role,
			headerServers: IDENTITY_HEADERS.servers,
			trustedProxies: [...LOOPBACK]
		});
		expect(out.Portal).toEqual({ url: 'https://admin.example.com', label: 'Admin portal' });
		expect(out.Servers).toHaveLength(2);
	});
	it('keeps an operator cookieSecret, derives one otherwise, and does not mutate the input', () => {
		const input = { Servers: [], cookieSecret: 'operator-secret' };
		expect((overlayRedisAdmin(input, ctx('redisadmin')) as any).cookieSecret).toBe(
			'operator-secret'
		);
		expect((overlayRedisAdmin({ Servers: [] }, ctx('redisadmin')) as any).cookieSecret).toBe(
			'derived-secret-derived-secret-1234'
		);
		expect(input).toEqual({ Servers: [], cookieSecret: 'operator-secret' });
	});
	it('rejects a non-object', () => {
		expect(() => overlayRedisAdmin([], ctx('redisadmin'))).toThrow(ConfigError);
	});
});

describe('overlayMyAdmin', () => {
	const cfg = {
		Servers: [
			{ verbose: 'Prod', host: 'mysql', user: 'admin', password: 's', auth_type: 'cookie' },
			{
				host: 'other',
				user: 'root',
				Signon: { authorize: { namespace: 'prod' }, identity: { userHeader: 'x-evil' } }
			}
		],
		ServerDiscovery: { type: 'kubernetes', server: { pmadb: 'phpmyadmin' } }
	};
	it('makes every server signon over loopback and keeps authorize', () => {
		const out = overlayMyAdmin(cfg, ctx('myadmin')) as Record<string, any>;
		for (const server of out.Servers) {
			expect(server.auth_type).toBe('signon');
			expect(server.SignonURL).toBe('https://admin.example.com/go/myadmin');
			expect(server.LogoutURL).toBe('https://admin.example.com/logout');
			expect(server.Signon.identity).toMatchObject({
				type: 'trusted-header',
				userHeader: IDENTITY_HEADERS.user,
				emailHeader: IDENTITY_HEADERS.email,
				groupsHeader: IDENTITY_HEADERS.groups,
				trustedProxies: [...LOOPBACK]
			});
		}
		expect(out.Servers[1].Signon.authorize).toEqual({ namespace: 'prod' });
		expect(out.ServerDiscovery.server.pmadb).toBe('phpmyadmin');
		expect(out.ServerDiscovery.server.Signon.identity.trustedProxies).toEqual([...LOOPBACK]);
		expect(out.TrustedProxies).toEqual({
			'127.0.0.1': 'X-Forwarded-For',
			'::1': 'X-Forwarded-For'
		});
		expect(out.Portal).toEqual({ url: 'https://admin.example.com', label: 'Admin portal' });
	});
	it('does not mutate the input', () => {
		const before = structuredClone(cfg);
		overlayMyAdmin(cfg, ctx('myadmin'));
		expect(cfg).toEqual(before);
	});
	it('names the server that lacks a user', () => {
		expect(() =>
			overlayMyAdmin({ Servers: [{ verbose: 'Staging', host: 'h' }] }, ctx('myadmin'))
		).toThrow(/Servers\[0\] \(Staging\)/);
	});
	it('the sample (cookie auth, no user) is refused with a clear message', () => {
		expect(() => overlayMyAdmin(sample(MYADMIN_SAMPLE), ctx('myadmin'))).toThrow(ConfigError);
	});
});

describe('parseAppId', () => {
	it('accepts known ids only', () => {
		expect(parseAppId('myadmin')).toBe('myadmin');
		expect(parseAppId('constructor')).toBeNull();
	});
});
