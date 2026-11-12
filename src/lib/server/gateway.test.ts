import { describe, expect, it } from 'vitest';
import { upstreamHeaders } from './gateway.ts';
import type { Principal } from './access.ts';

const principal = (over: Partial<Principal> = {}): Principal => ({
	source: 'oidc',
	user: 'alice',
	email: 'alice@example.com',
	groups: ['devs'],
	kubeGroups: ['devs', 'oidc:ops'],
	sid: null,
	grants: {
		myadmin: true,
		userAdmin: false,
		redisadmin: { role: 'rw', servers: ['cache', 'sessions', 'gone'] }
	},
	...over
});

const forged = new Headers({
	'x-multiadmin-user': 'root',
	'x-multiadmin-role': 'admin',
	'x-multiadmin-servers': '0,1,2',
	'x-multiadmin-groups': 'system:masters',
	'x-auth-request-user': 'root',
	'x-forwarded-for': '6.6.6.6',
	forwarded: 'for=6.6.6.6',
	'x-real-ip': '6.6.6.6',
	connection: 'keep-alive, x-secret',
	'x-secret': 'hop',
	'keep-alive': 'timeout=5',
	'transfer-encoding': 'chunked',
	'accept-encoding': 'gzip',
	'content-type': 'application/json',
	cookie: 'multiadmin_session=abc.def; sra_session=keep; theme=dark',
	'x-custom': 'ok'
});

describe('upstreamHeaders', () => {
	it('drops every forgeable header and keeps the rest', () => {
		const h = upstreamHeaders(forged, 'redisadmin', principal(), '203.0.113.7', [
			'cache',
			'x',
			'sessions'
		]);
		expect(h.get('x-multiadmin-user')).toBe('alice');
		expect(h.get('x-multiadmin-groups')).toBe('devs,oidc:ops');
		expect(h.get('x-multiadmin-role')).toBe('rw');
		expect(h.get('x-multiadmin-servers')).toBe('0,2'); // 'gone' ignored
		expect(h.get('x-forwarded-for')).toBe('203.0.113.7');
		for (const name of [
			'x-auth-request-user',
			'forwarded',
			'x-real-ip',
			'connection',
			'x-secret',
			'keep-alive',
			'transfer-encoding'
		]) {
			expect(h.has(name)).toBe(false);
		}
		expect(h.get('accept-encoding')).toBe('identity');
		expect(h.get('content-type')).toBe('application/json');
		expect(h.get('x-custom')).toBe('ok');
		expect(h.get('cookie')).toBe('sra_session=keep; theme=dark');
	});
	it('drops the cookie header when only the portal cookie was in it', () => {
		const h = upstreamHeaders(
			new Headers({ cookie: 'multiadmin_session=a.b' }),
			'myadmin',
			principal(),
			'1.1.1.1'
		);
		expect(h.has('cookie')).toBe(false);
	});
	it('myadmin gets no role or servers, even if the client sent them', () => {
		const h = upstreamHeaders(forged, 'myadmin', principal(), '1.1.1.1');
		expect(h.get('x-multiadmin-user')).toBe('alice');
		expect(h.has('x-multiadmin-role')).toBe(false);
		expect(h.has('x-multiadmin-servers')).toBe(false);
	});
	it('redis "all" servers omits the header; named servers with no match send an empty list', () => {
		const all = principal({
			grants: { myadmin: false, userAdmin: false, redisadmin: { role: 'ro', servers: 'all' } }
		});
		const h = upstreamHeaders(forged, 'redisadmin', all, '1.1.1.1', ['a']);
		expect(h.get('x-multiadmin-role')).toBe('ro');
		expect(h.has('x-multiadmin-servers')).toBe(false);
		const none = principal({
			grants: { myadmin: false, userAdmin: false, redisadmin: { role: 'ro', servers: ['zzz'] } }
		});
		expect(
			upstreamHeaders(forged, 'redisadmin', none, '1.1.1.1', ['a']).get('x-multiadmin-servers')
		).toBe('');
	});
	it('forwards no groups for local users and drops groups that would inject into the list', () => {
		const local = principal({ source: 'local', kubeGroups: [] });
		expect(upstreamHeaders(forged, 'myadmin', local, '1.1.1.1').has('x-multiadmin-groups')).toBe(
			false
		);
		const odd = principal({ kubeGroups: ['ok', 'a,system:masters', 'b\tc'] });
		expect(upstreamHeaders(forged, 'myadmin', odd, '1.1.1.1').get('x-multiadmin-groups')).toBe(
			'ok'
		);
	});
	it('omits email when unknown and refuses a missing grant', () => {
		expect(
			upstreamHeaders(forged, 'myadmin', principal({ email: null }), '1.1.1.1').has(
				'x-multiadmin-email'
			)
		).toBe(false);
		const none = principal({ grants: { myadmin: false, userAdmin: false, redisadmin: null } });
		expect(() => upstreamHeaders(forged, 'myadmin', none, '1.1.1.1')).toThrow(/no myadmin grant/);
		expect(() => upstreamHeaders(forged, 'redisadmin', none, '1.1.1.1')).toThrow(
			/no redisadmin grant/
		);
	});
});
