import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { authenticate, loginLocal, logout, type AuthDeps } from './index.ts';
import { openLocalUserStore } from './local.ts';
import { LoginLimiter } from './rate-limit.ts';
import { parsePortalConfig } from '../config/schema.ts';
import { createSessionStore, SESSION_COOKIE } from '../session.ts';

const config = parsePortalConfig(
	{
		publicUrl: 'https://admin.example.com',
		cookieSecret: 'x'.repeat(32),
		auth: { type: 'local', usersFile: 'u.json' },
		access: [
			{ match: { group: 'platform-admins' }, grants: { myadmin: true, userAdmin: true } },
			{ match: { group: '*' }, grants: { redisadmin: { role: 'ro' } } }
		],
		apps: {}
	},
	{ baseDir: '/c' }
);

async function setup() {
	const users = await openLocalUserStore(
		join(mkdtempSync(join(tmpdir(), 'ma-auth-')), 'u.json'),
		null
	);
	await users.upsert({
		username: 'root',
		groups: ['platform-admins'],
		email: null,
		disabled: false,
		password: 'password-1'
	});
	const jar = new Map<string, string>();
	const event = {
		url: new URL('https://admin.example.com/login'),
		cookies: {
			get: (n: string) => jar.get(n),
			set: (n: string, v: string) => void jar.set(n, v),
			delete: (n: string) => void jar.delete(n)
		}
	} as never;
	const deps: AuthDeps = {
		config: () => config,
		sessions: (
			(store) => () =>
				store
		)(createSessionStore({ secret: 'x'.repeat(32), ttlSeconds: 600 })),
		users: async () => users,
		limiter: new LoginLimiter(2, 60_000)
	};
	return { users, jar, event, deps };
}

describe('local auth', () => {
	it('logs in, authenticates with grants, and logs out', async () => {
		const { event, deps, jar } = await setup();
		expect(await authenticate(event, deps)).toBeNull();
		expect(await loginLocal(event, 'ROOT', 'password-1', deps)).toBe('ok');
		const p = await authenticate(event, deps);
		expect(p).toMatchObject({ user: 'root', source: 'local', kubeGroups: [] });
		expect(p?.grants).toMatchObject({
			myadmin: true,
			userAdmin: true,
			redisadmin: { role: 'ro', servers: 'all' }
		});
		logout(event, deps);
		expect(jar.has(SESSION_COOKIE)).toBe(false);
		expect(await authenticate(event, deps)).toBeNull();
	});
	it('applies edits and disabling on the next request', async () => {
		const { event, deps, users } = await setup();
		await loginLocal(event, 'root', 'password-1', deps);
		await users.upsert({ username: 'root', groups: [], email: null, disabled: false });
		expect((await authenticate(event, deps))?.grants.myadmin).toBe(false);
		await users.upsert({ username: 'root', groups: [], email: null, disabled: true });
		expect(await authenticate(event, deps)).toBeNull();
	});
	it('rejects wrong passwords and locks after repeated failures', async () => {
		const { event, deps } = await setup();
		expect(await loginLocal(event, 'root', 'bad', deps)).toBe('invalid');
		expect(await loginLocal(event, 'root', 'bad', deps)).toBe('invalid');
		expect(await loginLocal(event, 'root', 'password-1', deps)).toBe('locked');
	});
	it('ignores a tampered cookie', async () => {
		const { event, deps, jar } = await setup();
		await loginLocal(event, 'root', 'password-1', deps);
		jar.set(SESSION_COOKIE, jar.get(SESSION_COOKIE)! + 'x');
		expect(await authenticate(event, deps)).toBeNull();
	});
});
