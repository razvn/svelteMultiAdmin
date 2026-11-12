import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APPS } from './apps.ts';
import type { Principal } from './access.ts';
import {
	childEnv,
	childPort,
	childState,
	redisServerNames,
	startChildren,
	stopChildren
} from './children.ts';
import { parsePortalConfig } from './config/schema.ts';
import { forward } from './gateway.ts';

const freePort = () =>
	new Promise<number>((resolve) => {
		const s = createServer().listen(0, '127.0.0.1', () => {
			const { port } = s.address() as { port: number };
			s.close(() => resolve(port));
		});
	});

const until = async (check: () => boolean, ms = 8000) => {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error('timed out');
		await new Promise((r) => setTimeout(r, 25));
	}
};

describe('childEnv', () => {
	const parent = {
		PATH: '/bin',
		NODE_ENV: 'production',
		KUBERNETES_SERVICE_HOST: '10.0.0.1',
		ADDRESS_HEADER: 'x-forwarded-for',
		ORIGIN: 'https://evil',
		PORT: '3000',
		HOST: '0.0.0.0',
		BODY_SIZE_LIMIT: 'Infinity',
		MULTIADMIN_CONFIG: '/c.json',
		OIDC_SECRET: 's',
		SMA_CONFIG: '/other',
		MULTIADMIN_MYADMIN_BODY_SIZE_LIMIT: '2G'
	};
	it('drops the denylist, keeps the rest, and sets host, port, origin and config', () => {
		const env = childEnv(
			parent,
			'myadmin',
			'/tmp/m.json',
			new URL('https://mysql.example.com/x'),
			3101
		);
		expect(env).toEqual({
			PATH: '/bin',
			NODE_ENV: 'production',
			KUBERNETES_SERVICE_HOST: '10.0.0.1',
			HOST: '127.0.0.1',
			PORT: '3101',
			ORIGIN: 'https://mysql.example.com',
			SMA_CONFIG: '/tmp/m.json',
			BODY_SIZE_LIMIT: '2G'
		});
	});
	it('gives redis its own config variable and no body limit by default', () => {
		const env = childEnv(
			parent,
			'redisadmin',
			'/tmp/r.json',
			new URL('https://r.example.com'),
			3102
		);
		expect(env['SRA_CONFIG']).toBe('/tmp/r.json');
		expect(env['SMA_CONFIG']).toBeUndefined();
		expect(env['BODY_SIZE_LIMIT']).toBeUndefined();
	});
});

describe('children + forward (real processes)', () => {
	const alice: Principal = {
		source: 'oidc',
		user: 'alice',
		email: 'alice@example.com',
		groups: [],
		kubeGroups: ['devs'],
		sid: null,
		grants: { myadmin: true, userAdmin: false, redisadmin: { role: 'rw', servers: ['sessions'] } }
	};
	const event = (url: string, init: RequestInit = {}) => {
		const request = new Request(url, init);
		return { request, url: new URL(url), getClientAddress: () => '203.0.113.7' };
	};
	let ports: { myadmin: number; redisadmin: number };

	beforeAll(async () => {
		const root = mkdtempSync(join(tmpdir(), 'ma-test-'));
		const fake = new URL('./testing/fake-child.js', import.meta.url).pathname;
		for (const app of ['myadmin', 'redisadmin']) {
			mkdirSync(join(root, 'children', app, 'build'), { recursive: true });
			copyFileSync(fake, join(root, 'children', app, 'build', 'index.js'));
			writeFileSync(join(root, 'children', app, 'package.json'), '{"type":"module"}');
		}
		writeFileSync(
			join(root, 'myadmin.json'),
			JSON.stringify({ Servers: [{ host: 'db', user: 'root' }] })
		);
		writeFileSync(
			join(root, 'redisadmin.json'),
			JSON.stringify({ Servers: [{ name: 'cache' }, { name: 'sessions' }] })
		);
		const config = parsePortalConfig(
			{
				publicUrl: 'http://portal.localhost:3000',
				cookieSecret: 'x'.repeat(32),
				auth: { type: 'local', usersFile: 'u.json' },
				apps: {
					myadmin: { publicUrl: 'http://myadmin.localhost:3000', config: 'myadmin.json' },
					redisadmin: { publicUrl: 'http://redisadmin.localhost:3000', config: 'redisadmin.json' }
				}
			},
			{ baseDir: root }
		);
		ports = { myadmin: await freePort(), redisadmin: await freePort() };
		await startChildren(config, {
			childrenDir: join(root, 'children'),
			ports,
			pollMs: 20,
			backoffMs: { initial: 20, max: 40 },
			env: {
				PATH: process.env['PATH'],
				MULTIADMIN_CONFIG: 'secret',
				ADDRESS_HEADER: 'x-forwarded-for'
			}
		});
		await until(
			() => childState('myadmin') === 'healthy' && childState('redisadmin') === 'healthy'
		);
	});
	afterAll(stopChildren);

	it('exposes ports and the redis server names from the overlaid config', () => {
		expect(childPort('redisadmin')).toBe(ports.redisadmin);
		expect(redisServerNames()).toEqual(['cache', 'sessions']);
	});

	it('proxies with the real identity, ignoring forged headers, and scrubs the child env', async () => {
		const res = await forward(
			event('http://redisadmin.localhost:3000/server/1?x=2', {
				headers: {
					'x-multiadmin-role': 'admin',
					'x-multiadmin-user': 'root',
					cookie: 'multiadmin_session=a.b; k=v'
				}
			}),
			'redisadmin',
			alice,
			[]
		);
		const seen = await res.json();
		expect(res.status).toBe(200);
		expect(seen.url).toBe('/server/1?x=2');
		expect(seen.headers['x-multiadmin-user']).toBe('alice');
		expect(seen.headers['x-multiadmin-role']).toBe('rw');
		expect(seen.headers['x-multiadmin-servers']).toBe('1');
		expect(seen.headers['x-forwarded-for']).toBe('203.0.113.7');
		expect(seen.headers.cookie).toBe('k=v');
		expect(seen.env.ORIGIN).toBe('http://redisadmin.localhost:3000');
		expect(seen.env.SRA_CONFIG).toMatch(/redisadmin\.json$/);
		expect(seen.env.MULTIADMIN_CONFIG).toBeUndefined();
		expect(seen.env.ADDRESS_HEADER).toBeUndefined();
	});

	it('behind a trusted proxy the child sees the real client, not the proxy', async () => {
		const behind = event('http://myadmin.localhost:3000/echo', {
			headers: { 'x-forwarded-for': '6.6.6.6, 198.51.100.9' }
		});
		const res = await forward(
			{ ...behind, getClientAddress: () => '10.42.0.1' },
			'myadmin',
			alice,
			['10.42.0.0/16']
		);
		expect((await res.json()).headers['x-forwarded-for']).toBe('198.51.100.9');
		const direct = await forward(
			{ ...behind, getClientAddress: () => '203.0.113.7' },
			'myadmin',
			alice,
			['10.42.0.0/16']
		);
		expect((await direct.json()).headers['x-forwarded-for']).toBe('203.0.113.7'); // untrusted peer: header ignored
	});

	it('streams request bodies and keeps redirects and every Set-Cookie', async () => {
		const post = await forward(
			event('http://myadmin.localhost:3000/echo', { method: 'POST', body: 'hello' }),
			'myadmin',
			alice,
			[]
		);
		expect((await post.json()).body).toBe('hello');
		const redirect = await forward(
			event('http://myadmin.localhost:3000/redirect'),
			'myadmin',
			alice,
			[]
		);
		expect(redirect.status).toBe(302);
		expect(redirect.headers.get('location')).toBe('https://app.example.com/next');
		const cookies = await forward(
			event('http://myadmin.localhost:3000/cookies'),
			'myadmin',
			alice,
			[]
		);
		expect(cookies.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/; HttpOnly']);
	});

	it('restarts a crashed child, answering 503 meanwhile', async () => {
		await forward(event('http://myadmin.localhost:3000/crash'), 'myadmin', alice, []).catch(
			() => undefined
		);
		await until(() => childState('myadmin') !== 'healthy');
		const during = await forward(event('http://myadmin.localhost:3000/'), 'myadmin', alice, []);
		expect(during.status).toBe(503);
		await until(() => childState('myadmin') === 'healthy');
		expect(
			(await forward(event('http://myadmin.localhost:3000/echo'), 'myadmin', alice, [])).status
		).toBe(200);
	});

	it('is idempotent', async () => {
		const before = childPort('myadmin');
		await startChildren();
		expect(childPort('myadmin')).toBe(before);
	});
});

it('APPS stays the source of the config env names', () => {
	expect(APPS.myadmin.configEnv).toBe('SMA_CONFIG');
});
