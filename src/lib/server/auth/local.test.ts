import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashPassword, LocalUserError, openLocalUserStore, verifyPassword } from './local.ts';
import { LoginLimiter } from './rate-limit.ts';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'ma-users-')), 'users.json');
const env = { MULTIADMIN_BOOTSTRAP_PASSWORD: 'bootstrap-pass' };

describe('passwords', () => {
	it('hash with a fresh salt and verify only the right password', async () => {
		const a = await hashPassword('correct horse');
		expect(a).not.toBe(await hashPassword('correct horse'));
		expect(await verifyPassword('correct horse', a)).toBe(true);
		expect(await verifyPassword('wrong', a)).toBe(false);
		expect(await verifyPassword('x', 'garbage')).toBe(false);
	});
});

describe('LocalUserStore', () => {
	it('creates the bootstrap admin once, with the default group, and persists it 0600', async () => {
		const file = tmp();
		const store = await openLocalUserStore(file, 'Admin'.toLowerCase(), { env });
		expect(store.get('admin')).toMatchObject({ groups: ['platform-admins'], disabled: false });
		expect(statSync(file).mode & 0o777).toBe(0o600);
		const again = await openLocalUserStore(file, 'admin', {}); // exists: no password needed
		expect((await again.verify('ADMIN', 'bootstrap-pass'))?.username).toBe('admin');
	});
	it('refuses a missing bootstrap password for a new bootstrap admin', async () => {
		await expect(openLocalUserStore(tmp(), 'admin', { env: {} })).rejects.toThrow(
			/MULTIADMIN_BOOTSTRAP_PASSWORD/
		);
	});
	it('verifies passwords, rejects unknown and disabled users', async () => {
		const store = await openLocalUserStore(tmp(), null);
		await store.upsert({
			username: 'Bob',
			groups: ['devs', ' devs ', ''],
			email: 'bob@example.com',
			disabled: false,
			password: 'longenough'
		});
		expect(store.get('bob')?.groups).toEqual(['devs']);
		expect(await store.verify('bob', 'longenough')).not.toBeNull();
		expect(await store.verify('bob', 'nope')).toBeNull();
		expect(await store.verify('ghost', 'longenough')).toBeNull();
		await store.upsert({ username: 'bob', groups: ['devs'], email: null, disabled: true });
		expect(await store.verify('bob', 'longenough')).toBeNull(); // password kept, user disabled
	});
	it('keeps the old password when none is given, and survives a reload', async () => {
		const file = tmp();
		const store = await openLocalUserStore(file, null);
		await store.upsert({
			username: 'amy',
			groups: [],
			email: null,
			disabled: false,
			password: 'password-1'
		});
		await store.upsert({ username: 'amy', groups: ['ops'], email: null, disabled: false });
		const reopened = await openLocalUserStore(file, null);
		expect((await reopened.verify('amy', 'password-1'))?.groups).toEqual(['ops']);
		await reopened.remove('amy');
		expect(JSON.parse(readFileSync(file, 'utf8')).users).toEqual([]);
	});
	it('validates input', async () => {
		const store = await openLocalUserStore(tmp(), null);
		const base = { groups: [], email: null, disabled: false };
		await expect(
			store.upsert({ ...base, username: 'a,b', password: 'longenough' })
		).rejects.toThrow(LocalUserError);
		await expect(
			store.upsert({ ...base, username: 'ok', password: 'short' })
		).rejects.toMatchObject({
			message: 'Password: at least {n} characters.',
			params: { n: 8 }
		});
		await expect(store.upsert({ ...base, username: 'ok' })).rejects.toThrow(/needs a password/);
		await expect(
			store.upsert({ ...base, username: 'ok', groups: ['a,b'], password: 'longenough' })
		).rejects.toThrow(/commas/);
		await expect(
			store.upsert({ ...base, username: 'ok', email: 'nope', password: 'longenough' })
		).rejects.toThrow(/Email/);
	});
});

describe('LoginLimiter', () => {
	it('locks after max failures, unlocks after the window, and clears on success', () => {
		let t = 0;
		const l = new LoginLimiter(3, 1000, () => t);
		for (let i = 0; i < 3; i++) l.fail('a');
		expect(l.locked('a')).toBe(true);
		expect(l.locked('b')).toBe(false);
		t = 1001;
		expect(l.locked('a')).toBe(false);
		l.fail('a');
		l.clear('a');
		expect(l.locked('a')).toBe(false);
	});
});
