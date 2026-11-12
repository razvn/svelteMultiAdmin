import type { AuthConfig } from '#lib/server/config/schema.ts';
import type { SessionId } from '#lib/server/session.ts';

export type RedisRole = 'ro' | 'rw' | 'admin';

/** `servers` are server NAMES from the child's config (positions drift); the overlay maps them to indexes. */
export interface RedisGrant {
	role: RedisRole;
	servers: 'all' | readonly string[];
}

export interface Grants {
	myadmin: boolean;
	redisadmin: RedisGrant | null;
	userAdmin: boolean;
}

export type GrantPatch = Partial<{
	myadmin: true;
	redisadmin: { role: RedisRole; servers?: string[] };
	userAdmin: true;
}>;

export interface AccessRule {
	match: { group: string } | { user: string } | { email: string }; // '*' allowed for group
	grants: GrantPatch;
}

export interface Identity {
	source: AuthConfig['type'];
	/** Stable id, no control characters, no comma. */
	user: string;
	email: string | null;
	/** Used for access rules. */
	groups: readonly string[];
	/** Forwarded to children (Kubernetes SAR). Always [] for source 'local'. */
	kubeGroups: readonly string[];
}

export interface Principal extends Identity {
	grants: Grants;
	/** null for trusted-header (no session of our own). */
	sid: SessionId | null;
}

const ROLE_RANK: Record<RedisRole, number> = { ro: 0, rw: 1, admin: 2 };

function matches(rule: AccessRule, identity: Identity): boolean {
	const m = rule.match;
	if ('group' in m) return m.group === '*' || identity.groups.includes(m.group);
	if ('user' in m) return m.user === identity.user;
	return identity.email !== null && m.email.toLowerCase() === identity.email.toLowerCase();
}

/**
 * Pure union over matching rules: OR booleans, max role, union servers ('all' absorbs; a rule with no
 * `servers` means all). `userAdmin` only ever holds for local users: the screen manages that user store.
 */
export function grantsFor(identity: Identity, rules: readonly AccessRule[]): Grants {
	let myadmin = false;
	let userAdmin = false;
	let role: RedisRole | null = null;
	let all = false;
	const names = new Set<string>();

	for (const rule of rules) {
		if (!matches(rule, identity)) continue;
		const g = rule.grants;
		if (g.myadmin) myadmin = true;
		if (g.userAdmin) userAdmin = true;
		if (g.redisadmin) {
			if (role === null || ROLE_RANK[g.redisadmin.role] > ROLE_RANK[role]) role = g.redisadmin.role;
			if (g.redisadmin.servers === undefined) all = true;
			else for (const name of g.redisadmin.servers) names.add(name);
		}
	}

	return {
		myadmin,
		userAdmin: userAdmin && identity.source === 'local',
		redisadmin: role === null ? null : { role, servers: all ? 'all' : [...names] }
	};
}
