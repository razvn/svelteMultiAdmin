import { describe, expect, it } from 'vitest';
import { createSessionStore, TICKET_TTL_MS } from './session.ts';
import type { Identity } from './access.ts';

const identity: Identity = {
	source: 'local',
	user: 'alice',
	email: null,
	groups: [],
	kubeGroups: []
};
const SECRET = 'x'.repeat(32);

function setup(secret = SECRET) {
	let t = 1_000_000;
	const store = createSessionStore({ secret, ttlSeconds: 60, now: () => t });
	return { store, advance: (ms: number) => (t += ms) };
}

describe('session cookie', () => {
	it('round-trips, and rejects tampering or another secret', () => {
		const { store } = setup();
		const s = store.create(identity);
		const cookie = store.cookieValue(s);
		expect(store.fromCookie(cookie)?.sid).toBe(s.sid);
		expect(store.fromCookie(cookie.slice(0, -2) + 'AA')).toBeNull();
		expect(store.fromCookie(`other.${cookie.split('.')[1]}`)).toBeNull();
		expect(setup('y'.repeat(32)).store.fromCookie(cookie)).toBeNull();
		expect(store.fromCookie(undefined)).toBeNull();
		expect(store.fromCookie('nodot')).toBeNull();
	});
	it('expires and can be revoked', () => {
		const { store, advance } = setup();
		const a = store.create(identity);
		const b = store.create(identity);
		store.revoke(b.sid);
		expect(store.fromCookie(store.cookieValue(b))).toBeNull();
		advance(61_000);
		expect(store.fromCookie(store.cookieValue(a))).toBeNull();
	});
});

describe('tickets', () => {
	it('redeem once, for the right app only', () => {
		const { store } = setup();
		const s = store.create(identity);
		const ticket = store.issueTicket(s.sid, 'redisadmin');
		expect(store.redeemTicket(ticket, 'myadmin')).toBeNull();
		expect(store.redeemTicket(ticket, 'redisadmin')).toBe(s.sid);
		expect(store.redeemTicket(ticket, 'redisadmin')).toBeNull(); // burned
	});
	it('expire after 30 seconds', () => {
		const { store, advance } = setup();
		const s = store.create(identity);
		const ticket = store.issueTicket(s.sid, 'myadmin');
		advance(TICKET_TTL_MS + 1);
		expect(store.redeemTicket(ticket, 'myadmin')).toBeNull();
	});
	it('die with their session, and a session cookie is not a ticket', () => {
		const { store } = setup();
		const s = store.create(identity);
		const ticket = store.issueTicket(s.sid, 'myadmin');
		store.revoke(s.sid);
		expect(store.redeemTicket(ticket, 'myadmin')).toBeNull();
		const s2 = store.create(identity);
		expect(store.redeemTicket(store.cookieValue(s2), 'myadmin')).toBeNull();
	});
	it('reject garbage and forged payloads', () => {
		const { store } = setup();
		for (const bad of ['', 'x', 'a.b', '.']) expect(store.redeemTicket(bad, 'myadmin')).toBeNull();
	});
});
