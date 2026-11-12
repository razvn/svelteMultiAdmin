import { describe, expect, it } from 'vitest';
import { grantsFor, type AccessRule, type Identity } from './access.ts';

const who = (over: Partial<Identity> = {}): Identity => ({
	source: 'oidc',
	user: 'alice',
	email: 'Alice@Example.com',
	groups: ['devs'],
	kubeGroups: ['devs'],
	...over
});

const rules: AccessRule[] = [
	{
		match: { group: 'platform-admins' },
		grants: { myadmin: true, userAdmin: true, redisadmin: { role: 'admin' } }
	},
	{ match: { group: 'devs' }, grants: { redisadmin: { role: 'rw', servers: ['cache'] } } },
	{ match: { user: 'alice' }, grants: { redisadmin: { role: 'ro', servers: ['sessions'] } } },
	{ match: { email: 'alice@example.com' }, grants: { myadmin: true } },
	{ match: { group: '*' }, grants: { redisadmin: { role: 'ro', servers: [] } } }
];

describe('grantsFor', () => {
	it('grants nothing without a matching rule', () => {
		expect(grantsFor(who({ user: 'bob', email: null, groups: [] }), rules.slice(0, 3))).toEqual({
			myadmin: false,
			redisadmin: null,
			userAdmin: false
		});
	});
	it('takes the highest role and the union of servers across rules', () => {
		const g = grantsFor(who(), rules);
		expect(g.redisadmin).toEqual({ role: 'rw', servers: ['cache', 'sessions'] });
		expect(g.myadmin).toBe(true); // by email, case-insensitive
	});
	it('lets "all servers" (no servers key) absorb named servers', () => {
		const g = grantsFor(who({ groups: ['devs', 'platform-admins'] }), rules);
		expect(g.redisadmin).toEqual({ role: 'admin', servers: 'all' });
	});
	it('a "*" group matches everyone, and an empty server list stays empty', () => {
		const g = grantsFor(who({ user: 'bob', email: null, groups: [] }), [rules[4]!]);
		expect(g.redisadmin).toEqual({ role: 'ro', servers: [] });
	});
	it('userAdmin holds for local users only', () => {
		const admin = { groups: ['platform-admins'] };
		expect(grantsFor(who({ ...admin, source: 'local' }), rules).userAdmin).toBe(true);
		expect(grantsFor(who({ ...admin, source: 'oidc' }), rules).userAdmin).toBe(false);
		expect(grantsFor(who({ ...admin, source: 'trusted-header' }), rules).userAdmin).toBe(false);
	});
});
