import type { AccessRule } from '#lib/server/access.ts';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { APPS, type AppId } from '#lib/server/apps.ts';

export type Cidr = string;

export type AuthConfig =
	| {
			type: 'oidc';
			issuer: URL;
			clientId: string;
			clientSecret: string;
			groupsClaim: string;
			scopes: string[];
			/** Allow an http:// issuer (a local IdP in development). Never for production. */
			allowInsecureIssuer: boolean;
	  }
	| { type: 'local'; usersFile: string; bootstrapAdmin: string | null }
	| {
			type: 'trusted-header';
			userHeader: string;
			emailHeader: string | null;
			groupsHeader: string | null;
			/** Non-empty, enforced by parse. */
			trustedProxies: readonly Cidr[];
			logoutUrl: string | null;
	  };

export interface AppEntry {
	/** Origin only; host must be unique across the portal and all apps. */
	publicUrl: URL;
	/** Path of the child's own config JSON (`config` in multiadmin.json). */
	config: string;
	label: string;
}

export interface PortalConfig {
	publicUrl: URL;
	/** >= 32 chars. */
	cookieSecret: string;
	/** Default 8h. */
	sessionTtlSeconds: number;
	auth: AuthConfig;
	access: readonly AccessRule[];
	/** An omitted app is not spawned and not shown. */
	apps: Partial<Record<AppId, AppEntry>>;
}

export class PortalConfigError extends Error {
	override name = 'PortalConfigError';
}

const cidr = z.string().refine((value) => {
	const [address, bits, extra] = value.split('/');
	if (extra !== undefined) return false;
	const family = isIP(address ?? '');
	if (!family) return false;
	if (bits === undefined) return true;
	const n = Number(bits);
	return /^\d+$/.test(bits) && n >= 0 && n <= (family === 6 ? 128 : 32);
}, 'must be an IP address or CIDR range');

/** Origin only: http(s), no path, query or fragment. */
const originUrl = z
	.string()
	.transform((value, ctx) => {
		try {
			return new URL(value);
		} catch {
			ctx.addIssue({ code: 'custom', message: 'must be a URL' });
			return z.NEVER;
		}
	})
	.refine((u) => u.protocol === 'http:' || u.protocol === 'https:', 'must be http(s)')
	.refine(
		(u) => u.pathname === '/' && u.search === '' && u.hash === '',
		'must be an origin without path, query or fragment'
	);

const header = z.string().trim().min(1);

const authSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('oidc'),
		issuer: z.url(),
		clientId: z.string().min(1),
		clientSecret: z.string().min(1).optional(),
		clientSecretEnv: z.string().min(1).optional(),
		groupsClaim: z.string().min(1).default('groups'),
		scopes: z.array(z.string().min(1)).default(['openid', 'profile', 'email']),
		allowInsecureIssuer: z.boolean().default(false)
	}),
	z.object({
		type: z.literal('local'),
		usersFile: z.string().min(1),
		bootstrapAdmin: z.string().min(1).nullable().default(null)
	}),
	z.object({
		type: z.literal('trusted-header'),
		userHeader: header.default('x-auth-request-user'),
		emailHeader: header.nullable().default('x-auth-request-email'),
		groupsHeader: header.nullable().default('x-auth-request-groups'),
		trustedProxies: z.array(cidr).min(1, 'trustedProxies is required and must not be empty'),
		logoutUrl: z.string().min(1).nullable().default(null)
	})
]);

const matchSchema = z
	.object({ group: z.string().min(1), user: z.string().min(1), email: z.string().min(1) })
	.partial()
	.strict()
	.refine((m) => Object.keys(m).length === 1, 'match needs exactly one of group, user, email');

const grantsSchema = z
	.object({
		myadmin: z.literal(true),
		userAdmin: z.literal(true),
		redisadmin: z
			.object({
				role: z.enum(['ro', 'rw', 'admin']),
				servers: z.array(z.string().min(1)).optional()
			})
			.strict()
	})
	.partial()
	.strict();

const appSchema = z.object({
	publicUrl: originUrl,
	config: z.string().min(1),
	label: z.string().min(1).optional()
});

const portalSchema = z.object({
	publicUrl: originUrl,
	cookieSecret: z.string().min(32, 'cookieSecret must be at least 32 characters'),
	sessionTtlSeconds: z
		.number()
		.int()
		.positive()
		.default(8 * 60 * 60),
	auth: authSchema,
	access: z.array(z.object({ match: matchSchema, grants: grantsSchema })).default([]),
	apps: z.object({ myadmin: appSchema, redisadmin: appSchema }).partial().strict()
});

export interface ParseOptions {
	/** Relative paths (usersFile, apps.*.config) resolve from here. Default: the process cwd. */
	baseDir?: string;
	/** For `clientSecretEnv`. Default: process.env. */
	env?: Record<string, string | undefined>;
}

/**
 * Boundary: JSON -> domain types (zod). Rejects duplicate hosts, an app host equal to the portal host,
 * trusted-header without trustedProxies, cookieSecret shorter than 32. Throws PortalConfigError.
 */
export function parsePortalConfig(raw: unknown, options: ParseOptions = {}): PortalConfig {
	const parsed = portalSchema.safeParse(raw);
	if (!parsed.success) {
		throw new PortalConfigError(
			parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
		);
	}
	const c = parsed.data;
	const baseDir = options.baseDir ?? process.cwd();
	const env = options.env ?? process.env;

	let auth: AuthConfig;
	switch (c.auth.type) {
		case 'oidc': {
			const clientSecret =
				c.auth.clientSecret ?? (c.auth.clientSecretEnv ? env[c.auth.clientSecretEnv] : undefined);
			if (!clientSecret) {
				throw new PortalConfigError(
					`auth: oidc needs clientSecret, or clientSecretEnv naming a set environment variable${c.auth.clientSecretEnv ? ` (${c.auth.clientSecretEnv} is empty)` : ''}`
				);
			}
			auth = {
				type: 'oidc',
				issuer: new URL(c.auth.issuer),
				clientId: c.auth.clientId,
				clientSecret,
				groupsClaim: c.auth.groupsClaim,
				scopes: c.auth.scopes,
				allowInsecureIssuer: c.auth.allowInsecureIssuer
			};
			break;
		}
		case 'local':
			auth = { ...c.auth, usersFile: resolve(baseDir, c.auth.usersFile) };
			break;
		case 'trusted-header':
			auth = c.auth;
			break;
	}

	const apps: PortalConfig['apps'] = {};
	const hosts = new Map<string, string>([[c.publicUrl.host, 'publicUrl']]);
	for (const id of Object.keys(c.apps) as AppId[]) {
		const app = c.apps[id]!;
		const owner = hosts.get(app.publicUrl.host);
		if (owner) {
			throw new PortalConfigError(
				`apps.${id}.publicUrl: host ${app.publicUrl.host} is already used by ${owner}`
			);
		}
		hosts.set(app.publicUrl.host, `apps.${id}`);
		apps[id] = {
			publicUrl: app.publicUrl,
			config: resolve(baseDir, app.config),
			label: app.label ?? APPS[id].label
		};
	}

	return {
		publicUrl: c.publicUrl,
		cookieSecret: c.cookieSecret,
		sessionTtlSeconds: c.sessionTtlSeconds,
		auth,
		access: c.access as PortalConfig['access'],
		apps
	};
}

let cached: PortalConfig | undefined;

/** Reads MULTIADMIN_CONFIG once, fails fast. */
export function getPortalConfig(): PortalConfig {
	if (cached) return cached;
	const path = process.env['MULTIADMIN_CONFIG'];
	if (!path) throw new PortalConfigError('MULTIADMIN_CONFIG is not set');
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, 'utf8'));
	} catch (caught) {
		throw new PortalConfigError(`cannot read ${path}: ${(caught as Error).message}`);
	}
	cached = parsePortalConfig(raw, { baseDir: dirname(resolve(path)) });
	return cached;
}
