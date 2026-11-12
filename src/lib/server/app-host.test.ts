import { describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { Principal } from './access.ts';
import { appForHost, enterUrl, serveAppHost, type AppHostDeps } from './app-host.ts';
import { parsePortalConfig } from './config/schema.ts';
import { ENTER_PATH, createSessionStore, SESSION_COOKIE } from './session.ts';

const config = parsePortalConfig(
	{
		publicUrl: 'https://admin.example.com',
		cookieSecret: 'x'.repeat(32),
		auth: { type: 'local', usersFile: 'u.json' },
		apps: {
			myadmin: { publicUrl: 'https://mysql.admin.example.com', config: 'm.json' },
			redisadmin: { publicUrl: 'https://redis.admin.example.com:8443', config: 'r.json' }
		}
	},
	{ baseDir: '/c' }
);

const store = createSessionStore({ secret: 'x'.repeat(32), ttlSeconds: 600 });
const identity = {
	source: 'local',
	user: 'alice',
	email: null,
	groups: [],
	kubeGroups: []
} as const;
const session = store.create(identity);
const principal = (over: Partial<Principal> = {}): Principal => ({
	...identity,
	sid: session.sid,
	grants: { myadmin: true, userAdmin: false, redisadmin: null },
	...over
});

function setup(p: Principal | null) {
	const forward = vi.fn(async () => new Response('proxied'));
	const deps: AppHostDeps = {
		config: () => config,
		sessions: () => store,
		authenticate: async () => p,
		forward
	};
	const call = (url: string, method = 'GET', app: 'myadmin' | 'redisadmin' = 'myadmin') =>
		serveAppHost(
			{ request: new Request(url, { method }), url: new URL(url) } as unknown as RequestEvent,
			app,
			deps
		);
	return { forward, call };
}

describe('appForHost', () => {
	it('matches configured app hosts only, case-insensitively, port included', () => {
		expect(appForHost('mysql.admin.example.com', config)).toBe('myadmin');
		expect(appForHost('REDIS.admin.example.com:8443', config)).toBe('redisadmin');
		expect(appForHost('redis.admin.example.com', config)).toBeNull();
		expect(appForHost('admin.example.com', config)).toBeNull();
	});
});

describe('serveAppHost', () => {
	it('sends an anonymous GET to the portal /go with the return path, and 401s a POST', async () => {
		const { call, forward } = setup(null);
		const res = await call('https://mysql.admin.example.com/server/1?x=2');
		expect(res.status).toBe(303);
		expect(res.headers.get('location')).toBe(
			'https://admin.example.com/go/myadmin?rd=%2Fserver%2F1%3Fx%3D2'
		);
		expect((await call('https://mysql.admin.example.com/x', 'POST')).status).toBe(401);
		expect(forward).not.toHaveBeenCalled();
	});
	it('refuses a person without a grant for the app, with a link back', async () => {
		const { call, forward } = setup(principal());
		const res = await call('https://redis.admin.example.com:8443/', 'GET', 'redisadmin');
		expect(res.status).toBe(403);
		expect(await res.text()).toContain('href="https://admin.example.com"');
		expect(forward).not.toHaveBeenCalled();
	});
	it('forwards a granted request', async () => {
		const { call, forward } = setup(principal());
		expect(await (await call('https://mysql.admin.example.com/')).text()).toBe('proxied');
		expect(forward).toHaveBeenCalledOnce();
	});
	it('redeems a ticket once: sets the host cookie and redirects to rd', async () => {
		const { call, forward } = setup(null);
		const ticket = store.issueTicket(session.sid, 'myadmin');
		const url = `https://mysql.admin.example.com${ENTER_PATH}?ticket=${encodeURIComponent(ticket)}&rd=%2Fserver%2F1`;
		const res = await call(url);
		expect(res.status).toBe(303);
		expect(res.headers.get('location')).toBe('/server/1');
		const cookie = res.headers.get('set-cookie')!;
		expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
		expect(cookie).toMatch(/HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
		expect(store.fromCookie(cookie.split(';')[0]!.split('=').slice(1).join('='))?.sid).toBe(
			session.sid
		);
		const again = await call(url);
		expect(again.status).toBe(403); // replay: a page, not a redirect loop
		expect(forward).not.toHaveBeenCalled();
	});
	it('rejects a ticket for another app, an open-redirect rd, and non-GET on the enter path', async () => {
		const { call } = setup(null);
		const other = store.issueTicket(session.sid, 'redisadmin');
		expect(
			(
				await call(
					`https://mysql.admin.example.com${ENTER_PATH}?ticket=${encodeURIComponent(other)}`
				)
			).status
		).toBe(403);
		const t = store.issueTicket(session.sid, 'myadmin');
		const res = await call(
			`https://mysql.admin.example.com${ENTER_PATH}?ticket=${encodeURIComponent(t)}&rd=%2F%2Fevil.test`
		);
		expect(res.headers.get('location')).toBe('/');
		expect((await call(`https://mysql.admin.example.com${ENTER_PATH}`, 'POST')).status).toBe(405);
	});
});

describe('enterUrl', () => {
	const deps = { config: () => config, sessions: () => store };
	it('mints a ticket for session principals', () => {
		const url = new URL(enterUrl(principal(), 'myadmin', '/a?b=1', deps));
		expect(url.origin).toBe('https://mysql.admin.example.com');
		expect(url.pathname).toBe(ENTER_PATH);
		expect(url.searchParams.get('rd')).toBe('/a?b=1');
		expect(store.redeemTicket(url.searchParams.get('ticket')!, 'myadmin')).toBe(session.sid);
	});
	it('goes straight to the path for trusted-header principals, and sanitizes rd', () => {
		expect(enterUrl(principal({ sid: null }), 'redisadmin', '/x', deps)).toBe(
			'https://redis.admin.example.com:8443/x'
		);
		expect(enterUrl(principal({ sid: null }), 'myadmin', '//evil', deps)).toBe(
			'https://mysql.admin.example.com/'
		);
	});
});
