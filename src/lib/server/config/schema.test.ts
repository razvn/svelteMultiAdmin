import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePortalConfig, PortalConfigError } from './schema.ts';

const sample = () =>
	JSON.parse(readFileSync(new URL('../../../../config.sample.json', import.meta.url), 'utf8'));
const base = { baseDir: '/etc/multi' };

describe('parsePortalConfig', () => {
	it('accepts config.sample.json and fills defaults', () => {
		const c = parsePortalConfig(sample(), base);
		expect(c.sessionTtlSeconds).toBe(28800);
		expect(c.apps.myadmin).toMatchObject({ label: 'MySQL', config: '/etc/multi/myadmin.json' });
		expect(c.apps.redisadmin?.publicUrl.host).toBe('redisadmin.localhost:3000');
		expect(c.auth).toEqual({
			type: 'local',
			usersFile: '/etc/multi/var/users.json',
			bootstrapAdmin: 'admin'
		});
		expect(c.access).toHaveLength(3);
	});
	it('rejects a short cookieSecret', () => {
		expect(() => parsePortalConfig({ ...sample(), cookieSecret: 'short' }, base)).toThrow(
			/cookieSecret/
		);
	});
	it('rejects an app on the portal host, and two apps on one host', () => {
		const a = sample();
		a.apps.myadmin.publicUrl = a.publicUrl;
		expect(() => parsePortalConfig(a, base)).toThrow(/already used by publicUrl/);
		const b = sample();
		b.apps.myadmin.publicUrl = b.apps.redisadmin.publicUrl;
		expect(() => parsePortalConfig(b, base)).toThrow(/already used by apps/);
	});
	it('requires origin-only http(s) urls', () => {
		for (const bad of ['ftp://x', 'http://x/path', 'nonsense']) {
			expect(() => parsePortalConfig({ ...sample(), publicUrl: bad }, base)).toThrow(
				PortalConfigError
			);
		}
	});
	it('trusted-header needs non-empty valid trustedProxies and gets default headers', () => {
		const t = (trustedProxies: string[]) =>
			parsePortalConfig({ ...sample(), auth: { type: 'trusted-header', trustedProxies } }, base);
		expect(() => t([])).toThrow(/trustedProxies/);
		expect(() => t(['10.0.0.0/33'])).toThrow(PortalConfigError);
		expect(() => t(['nope'])).toThrow(PortalConfigError);
		expect(t(['10.42.0.0/16', '::1']).auth).toMatchObject({
			type: 'trusted-header',
			userHeader: 'x-auth-request-user',
			logoutUrl: null
		});
	});
	it('oidc takes the secret from clientSecretEnv or fails clearly', () => {
		const auth = {
			type: 'oidc',
			issuer: 'https://idp.example.com',
			clientId: 'multiadmin',
			clientSecretEnv: 'OIDC_SECRET'
		};
		const c = parsePortalConfig({ ...sample(), auth }, { ...base, env: { OIDC_SECRET: 's3cret' } });
		expect(c.auth).toMatchObject({ type: 'oidc', clientSecret: 's3cret', groupsClaim: 'groups' });
		expect(() => parsePortalConfig({ ...sample(), auth }, { ...base, env: {} })).toThrow(
			/OIDC_SECRET is empty/
		);
	});
	it('rejects malformed access rules', () => {
		const rule = (r: unknown) => parsePortalConfig({ ...sample(), access: [r] }, base);
		expect(() => rule({ match: {}, grants: {} })).toThrow(/exactly one/);
		expect(() => rule({ match: { group: 'a', user: 'b' }, grants: {} })).toThrow(/exactly one/);
		expect(() => rule({ match: { group: 'a' }, grants: { redisadmin: { role: 'root' } } })).toThrow(
			PortalConfigError
		);
		expect(() => rule({ match: { group: 'a' }, grants: { myadmin: false } })).toThrow(
			PortalConfigError
		);
	});
	it('rejects unknown apps', () => {
		const a = sample();
		a.apps.postgres = a.apps.myadmin;
		expect(() => parsePortalConfig(a, base)).toThrow(PortalConfigError);
	});
});
