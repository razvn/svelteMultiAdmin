import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { parseAppId, type AppId } from '#lib/server/apps.ts';
import type { Identity } from '#lib/server/access.ts';
import { getPortalConfig } from '#lib/server/config/schema.ts';

export type SessionId = string & { readonly __brand: 'SessionId' };
export type Ticket = string & { readonly __brand: 'Ticket' };

export interface Session {
	sid: SessionId;
	identity: Identity;
	/** epoch ms */
	expiresAt: number;
}

export const SESSION_COOKIE = 'multiadmin_session';
/** Reserved on app hosts, never proxied. */
export const ENTER_PATH = '/__multiadmin/enter';

export const TICKET_TTL_MS = 30_000;

export interface SessionStoreOptions {
	secret: string;
	ttlSeconds: number;
	/** Injectable clock (epoch ms) for tests. */
	now?: () => number;
}

/**
 * Sole owner of the in-memory session table and the burned-ticket-nonce set. One process, so "single
 * use" is exact. Cookie and ticket MACs use separate derived keys, so one can never stand in for the other.
 */
export interface SessionStore {
	create(identity: Identity): Session;
	/** Verifies the signature, then looks the sid up (expired or revoked -> null). */
	fromCookie(value: string | undefined): Session | null;
	cookieValue(session: Session): string;
	/** A live session by id (a redeemed ticket names one). */
	get(sid: SessionId): Session | null;
	revoke(sid: SessionId): void;
	/** HMAC{sid, app, exp = now + 30s, nonce}. */
	issueTicket(sid: SessionId, app: AppId): Ticket;
	/** Valid, unexpired, for this app, nonce unseen, session alive -> sid; the nonce is then burned. */
	redeemTicket(ticket: string, app: AppId): SessionId | null;
}

const b64 = (buf: Buffer) => buf.toString('base64url');

export function createSessionStore(options: SessionStoreOptions): SessionStore {
	const now = options.now ?? Date.now;
	const key = (label: string) =>
		createHmac('sha256', options.secret).update(`multiadmin:${label}`).digest();
	const cookieKey = key('cookie');
	const ticketKey = key('ticket');
	const sign = (k: Buffer, data: string) => b64(createHmac('sha256', k).update(data).digest());
	const verify = (k: Buffer, data: string, mac: string) => {
		const a = Buffer.from(sign(k, data));
		const b = Buffer.from(mac);
		return a.length === b.length && timingSafeEqual(a, b);
	};

	const sessions = new Map<SessionId, Session>();
	/** nonce -> ticket expiry; pruned once the ticket could not be valid anyway. */
	const burned = new Map<string, number>();

	const alive = (sid: SessionId): Session | null => {
		const s = sessions.get(sid);
		if (!s) return null;
		if (s.expiresAt <= now()) {
			sessions.delete(sid);
			return null;
		}
		return s;
	};

	return {
		create(identity) {
			const session: Session = {
				sid: b64(randomBytes(32)) as SessionId,
				identity,
				expiresAt: now() + options.ttlSeconds * 1000
			};
			sessions.set(session.sid, session);
			return session;
		},
		fromCookie(value) {
			if (!value) return null;
			const dot = value.indexOf('.');
			if (dot <= 0) return null;
			const sid = value.slice(0, dot);
			if (!verify(cookieKey, sid, value.slice(dot + 1))) return null;
			return alive(sid as SessionId);
		},
		get: (sid) => alive(sid),
		cookieValue: (session) => `${session.sid}.${sign(cookieKey, session.sid)}`,
		revoke: (sid) => void sessions.delete(sid),
		issueTicket(sid, app) {
			const payload = b64(
				Buffer.from(
					JSON.stringify({ sid, app, exp: now() + TICKET_TTL_MS, nonce: b64(randomBytes(16)) })
				)
			);
			return `${payload}.${sign(ticketKey, payload)}` as Ticket;
		},
		redeemTicket(ticket, app) {
			const dot = ticket.indexOf('.');
			if (dot <= 0) return null;
			const payload = ticket.slice(0, dot);
			if (!verify(ticketKey, payload, ticket.slice(dot + 1))) return null;
			let claims: { sid?: unknown; app?: unknown; exp?: unknown; nonce?: unknown };
			try {
				claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
			} catch {
				return null;
			}
			const { sid, exp, nonce } = claims;
			if (typeof sid !== 'string' || typeof nonce !== 'string' || typeof exp !== 'number')
				return null;
			if (parseAppId(String(claims.app)) !== app) return null;
			const t = now();
			for (const [n, until] of burned) if (until <= t) burned.delete(n);
			if (exp <= t || burned.has(nonce)) return null;
			if (!alive(sid as SessionId)) return null;
			burned.set(nonce, exp);
			return sid as SessionId;
		}
	};
}

let shared: SessionStore | undefined;

/** The portal's store, built once from the config. */
export function sessions(): SessionStore {
	const config = getPortalConfig();
	shared ??= createSessionStore({
		secret: config.cookieSecret,
		ttlSeconds: config.sessionTtlSeconds
	});
	return shared;
}
