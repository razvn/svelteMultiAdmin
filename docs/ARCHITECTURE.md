# svelteMultiAdmin architecture: in-process SSO gateway (host-per-app, loopback children)

> **Status (read this first).** This document is the design as sketched before implementation. The code in
> `src/lib/server/` and `scripts/` is now the source of truth; the type sketch below is the original and is
> **superseded where listed here**. For usage and configuration see [../README.md](../README.md).
>
> What changed while building it:
>
> - **Grants name Redis servers, not positions**: `RedisGrant.servers` is `'all' | readonly string[]` (the
>   server `name`s of the Redis config). `upstreamHeaders` takes the child's server names as a fifth argument and
>   sends positions to the child; unknown names grant nothing.
> - **Sessions are a factory**: `createSessionStore({ secret, ttlSeconds, now })` returns the store
>   (`create`, `fromCookie`, `cookieValue`, `get`, `revoke`, `issueTicket`, `redeemTicket`); `sessions()` is the
>   portal's lazily built instance. The free functions of the sketch are gone. Cookie and ticket MACs use
>   separate derived keys.
> - **Auth entry points**: `authenticate`, `loginLocal`, `logout` (local), `startOidc`/`finishOidc` (OIDC,
>   `/auth/login` and `/auth/callback`), `identityFromHeaders` (trusted-header). `startLogin`/`finishLogin` were
>   dropped. `userAdmin` only holds for local users.
> - **Config**: `apps.<id>.config` is the child config path (not `childConfigPath`); `parsePortalConfig(raw,
{ baseDir, env })` resolves relative paths and `clientSecretEnv`; OIDC has `allowInsecureIssuer`.
> - **Children**: `startChildren(config?, options?)`, `childEnv(parent, app, configFile, origin, port)`,
>   `childPort`, `redisServerNames`, `stopChildren`. `MULTIADMIN_CHILDREN_DIR` moves the child directory;
>   `MULTIADMIN_<APP>_BODY_SIZE_LIMIT` is the one portal variable a child inherits (as `BODY_SIZE_LIMIT`).
> - **MyAdmin client IP**: `TrustedProxies` in MyAdmin is phpMyAdmin's `{ ip: header }` map, not a list.
> - **Behind an SSO proxy** (`trusted-header`), the gateway resolves the real client from `X-Forwarded-For`
>   through the trusted proxies and passes it to the children for their audit logs.
> - **Cross-host redirects** use plain 303 responses: SvelteKit 3's `redirect()` refuses external locations
>   (found by running it).
> - **Proxy headers are mandatory in production**: adapter-node assumes `https` without `PROTOCOL_HEADER`, which
>   fails SvelteKit's CSRF origin check on every form POST. The Dockerfile sets `x-forwarded-proto`/`-host`.
> - **`bundle:update`** stages the pin and never commits; see the README. Neither child had a release tag when
>   this was written.
> - **Verified**: unit and integration tests (real child processes, real git, a fake OIDC provider) and a manual
>   run in a browser against the built children (sign-in, hand-off, proxying, back-link, restricted user,
>   logout). Not verified: a real OIDC provider, a real SSO proxy, Kubernetes, the Docker image, real MySQL/Redis.
> - **Interface and i18n**: the portal reuses the apps' design system and i18n mechanism (en/fr/es); the app-host
>   gate pages are translated from the request's `locals.i18n`. A test checks catalogs against the source.
> - **Kubernetes**: `deploy/kubernetes/multiadmin.yaml` (one replica, `Recreate`, PVC for the local accounts).
> - **Open**: OIDC provider logout. No audit log of the portal's own events: the apps' logs carry the person.

## Problem

svelteMultiAdmin must sign people in once (OIDC, local user admin, or the Kubernetes trusted-header mode)
and let them open svelteMyAdmin and svelteRedisAdmin without a second login, from one deployable bundle,
while the children stay separate repos pulled in as git submodules at release tags.

Constraints found in Phase A that force the shape:

- Both children already implement "SSO proxy in front of me": identity headers trusted only from a TCP
  peer in a CIDR list (`Signon.identity.trustedProxies` in MyAdmin, `auth.trustedProxies` in Redis),
  re-read on every request, with Kubernetes SAR (`authorize`) and `ServerDiscovery` built on that
  identity + groups. The peer is `event.getClientAddress()` (adapter-node), so `ADDRESS_HEADER` in a
  child's env would make the peer spoofable.
- Neither child supports a base path (`kit.paths.base` absent, ~18 hardcoded redirects and ~100 absolute
  fetch/action URLs). Mounting under `/myadmin` means a large patch in each child.
- Redis `headerRole` absent or unknown means `admin`; `headerServers` absent means all servers. A proxy
  that forgets a header grants everything.
- MyAdmin `signon` has no per-person role or server filter: every signed-in person uses the server's
  shared MySQL account, narrowed only by Kubernetes SAR.
- Neither child repo has any git tag yet (`git tag` is empty in both).
- adapter-node serves `build/client` (sirv) before `handle`, and caps request bodies at 512 KB by default.

## Usage (caller's view)

Operator quickstart (README of svelteMultiAdmin):

```sh
git clone --recurse-submodules git@github.com:razvn/svelteMultiAdmin.git
pnpm bundle:update            # move vendor/* to each child's latest v* tag, stage the gitlinks
git commit -m "bundle: svelteMyAdmin v0.4.0, svelteRedisAdmin v0.3.1"
docker build -t multiadmin .
docker run -p 3000:3000 \
  -v ./multiadmin.json:/config/multiadmin.json -v ./myadmin.json:/config/myadmin.json \
  -v ./redisadmin.json:/config/redisadmin.json -v multiadmin-data:/data \
  -e MULTIADMIN_CONFIG=/config/multiadmin.json multiadmin
# dev: open http://portal.localhost:3000 ; apps live at http://myadmin.localhost:3000, http://redisadmin.localhost:3000
```

`multiadmin.json` (the only file that knows about all three):

```jsonc
{
	"publicUrl": "https://admin.example.com",
	"cookieSecret": "32+ random chars",
	"auth": {
		"type": "oidc",
		"issuer": "https://idp.example.com",
		"clientId": "multiadmin",
		"clientSecretEnv": "OIDC_SECRET",
		"groupsClaim": "groups"
	},
	// or { "type": "local", "usersFile": "/data/users.json", "bootstrapAdmin": "admin" }   (password from MULTIADMIN_BOOTSTRAP_PASSWORD)
	// or { "type": "trusted-header", "userHeader": "x-auth-request-user", "emailHeader": "x-auth-request-email",
	//      "groupsHeader": "x-auth-request-groups", "trustedProxies": ["10.42.0.0/16"], "logoutUrl": "/oauth2/sign_out" }
	"access": [
		{
			"group": "platform-admins",
			"grants": { "myadmin": true, "redisadmin": { "role": "admin" }, "userAdmin": true }
		},
		{ "group": "devs", "grants": { "redisadmin": { "role": "rw", "servers": [0, 1] } } },
		{ "group": "*", "grants": { "redisadmin": { "role": "ro" } } }
	],
	"apps": {
		"myadmin": { "publicUrl": "https://mysql.admin.example.com", "config": "/config/myadmin.json" },
		"redisadmin": {
			"publicUrl": "https://redis.admin.example.com",
			"config": "/config/redisadmin.json"
		}
	}
}
```

`myadmin.json` / `redisadmin.json` are the children's normal configs (servers, discovery, audit). Their
auth keys are overwritten by MultiAdmin at start; the operator never writes header names or trusted CIDRs.

Call site 1, `src/hooks.server.ts` (whole file):

```ts
import { startChildren } from '#lib/server/children.ts';
import { appForHost, serveAppHost } from '#lib/server/app-host.ts';
import { authenticate } from '#lib/server/auth/index.ts';
import type { Handle, ServerInit } from '@sveltejs/kit';

export const init: ServerInit = () => startChildren();

export const handle: Handle = async ({ event, resolve }) => {
	const app = appForHost(event.url.host);
	if (app) return serveAppHost(event, app); // gate + proxy; never reaches SvelteKit routes
	event.locals.principal = await authenticate(event); // portal host
	return resolve(event);
};
```

Call site 2, the portal launcher link `src/routes/go/[app]/+server.ts`:

```ts
export const GET: RequestHandler = ({ params, url, locals }) => {
	const app = parseAppId(params.app) ?? error(404);
	if (!locals.principal) redirect(303, loginUrl(url));
	if (!locals.principal.grants[app]) error(403);
	redirect(303, enterUrl(locals.principal, app, safeReturnPath(url.searchParams.get('rd'))));
};
```

Call site 3, the launcher page `src/routes/+page.server.ts`:

```ts
export const load = ({ locals }) => ({
	apps: launchableApps(locals.principal ?? error(401)) // [{ id, label, href: '/go/myadmin' }]
});
```

Child side (both repos, same patch): `Portal` in the child config renders a "Back to portal" link.

```json
{ "Portal": { "url": "https://admin.example.com", "label": "Admin portal" } }
```

## Shape

### Topology

One container, one Node process tree:

```
ingress ──▶ :3000 MultiAdmin (SvelteKit, adapter-node)   Host = admin.*  → portal routes
                    │                                     Host = mysql.*  → gate → proxy ─▶ 127.0.0.1:3101 svelteMyAdmin (node build)
                    │                                     Host = redis.*  → gate → proxy ─▶ 127.0.0.1:3102 svelteRedisAdmin (node build)
                    └─ init(): spawns + supervises both children (child_process.spawn), restarts with backoff
```

- **One process tree, not a reverse-proxy container or three containers.** "Same server, same instance"
  is literal. Children bind `HOST=127.0.0.1`, so the only peer they ever see is MultiAdmin, and their
  `trustedProxies` becomes `["127.0.0.1/32", "::1/128"]`. No nginx/oauth2-proxy to configure, no network
  policy needed to hide the children.
- **Host per app, not path prefix.** Zero base-path work in the children. Dev uses `*.localhost`, which
  browsers resolve to loopback with no DNS. Production needs three DNS names on one Ingress, one Service
  port.
- **The proxy lives in `handle`, not a custom Node server.** One module graph, one config parse, one
  session table. The two adapter-node gotchas are handled by config, not code:
  `kit.appDir: '_multiadmin'` and an empty `static/` (a unit test asserts it) so sirv never shadows a
  child's `/_app/*` or `/favicon.png`; `BODY_SIZE_LIMIT=Infinity` on MultiAdmin (each child enforces its
  own limit, MultiAdmin's own forms parse small bodies). MultiAdmin runs with `PROTOCOL_HEADER` and
  `HOST_HEADER` so `event.url.origin` is the public origin, which keeps SvelteKit's CSRF origin check
  passing on all three hosts.

### Identity handoff

Trusted headers over loopback, because that is the contract both children already ship and test.
No signed token, because neither child can verify one without a new auth plugin.

The header names are one constant, owned by `apps.ts`, used both to write the child config overlay and
to set/strip headers on the proxied request (no hand-synced list):

```
x-multiadmin-user, x-multiadmin-email, x-multiadmin-groups, x-multiadmin-role, x-multiadmin-servers
```

Per proxied request, `gateway.ts`:

1. Deletes every inbound header in that set, plus the upstream identity headers of `trusted-header`
   mode, `Forwarded`, `X-Forwarded-*`, hop-by-hop headers and MultiAdmin's own session cookie.
2. Sets the identity headers from the `Principal` and `X-Forwarded-For` = client address (MyAdmin's
   top-level `TrustedProxies` overlay is loopback, so its audit log records the real client).
3. For Redis, always sends `x-multiadmin-role` and, unless the grant is `servers: 'all'`, always sends
   `x-multiadmin-servers` (possibly empty). The type `RedisGrant` has a required `role`, so the
   "absent role means admin" default of the child is unreachable.
4. `fetch(upstream, { redirect: 'manual', duplex: 'half', body: request.body })` with
   `accept-encoding: identity`; streams the response back, copying `Set-Cookie` via `getSetCookie()`.

Groups are forwarded only for `oidc` and `trusted-header` principals (`Principal.kubeGroups`). Local
users' groups never reach a child, because the child feeds groups into Kubernetes SubjectAccessReview
and a local admin could otherwise create a user in `system:masters`.

### Sessions across hosts

- `oidc` and `local`: a server-side session table in memory (`Map<sid, Session>`), cookie holds a signed
  `sid`, host-only, `HttpOnly; SameSite=Lax; Secure` in prod. One cookie per host, same `sid`.
  Logout on the portal deletes the `sid`, which kills the cookie on every host at once.
- Entering an app host without a cookie: `GET` redirects to `portal/go/<app>?rd=<path>`; the portal (where
  the person is signed in, or signs in now) mints a **ticket** (HMAC over `{sid, app, exp: now+30s,
nonce}`), redirects to `app/__multiadmin/enter?ticket=…&rd=…`; the gate redeems it once (nonce set,
  single process makes single-use exact), sets the host cookie, redirects to `rd`. Non-`GET` without a
  cookie gets `401`.
- `trusted-header`: no session, no ticket. The upstream proxy (oauth2-proxy with a parent cookie
  domain) must cover all three hosts; MultiAdmin reads the headers on every request on every host, from
  `trustedProxies` peers only, exactly like the children do today.

### Authorization

One path for every auth type: `grantsFor(identity, access)` is a pure fold over `access` rules matching
`group`, `user` or `email` (`"*"` matches everyone). Merge is union: `myadmin` OR, Redis role max
(`ro < rw < admin`), servers union with `'all'` absorbing. Local users get groups in the user-admin UI and
go through the same rules: there is no second "per-user grant" mechanism.

Grants are recomputed on every request (cheap, pure), so editing `access` or a local user's groups or
disabling a local user takes effect on the next click, on every host.

What the grants control:

| App                 | Gate in MultiAdmin                   | Forwarded to child          | Child still decides                                       |
| ------------------- | ------------------------------------ | --------------------------- | --------------------------------------------------------- |
| svelteMyAdmin       | `myadmin: true` or 403               | user, email, groups         | Kubernetes SAR per server (`Signon.authorize`, discovery) |
| svelteRedisAdmin    | `redisadmin` grant or 403            | user, groups, role, servers | role enforcement, server visibility, SAR                  |
| user admin (portal) | `userAdmin: true`, `local` auth only | —                           | —                                                         |

The design deliberately does not add per-server filtering to MyAdmin: its `signon` model is one shared
MySQL account per server, and the child patch is limited to the back-link.

### Children: supervision and config overlay

`children.ts` owns the processes. For each configured app in `APPS`:

1. Read the operator's child config, apply the app's pure overlay (below), write it to
   `$TMPDIR/multiadmin/<app>.json` (mode 0600), spawn `node <dir>/build` with an env built from the parent
   env minus a denylist (`ADDRESS_HEADER`, `XFF_DEPTH`, `ORIGIN`, `PROTOCOL_HEADER`, `HOST_HEADER`, `HOST`,
   `PORT`, `SOCKET_PATH`, `BODY_SIZE_LIMIT`, `SMA_CONFIG`, `SRA_CONFIG`, `MULTIADMIN_*`, `OIDC_*`) plus
   `HOST=127.0.0.1`, `PORT=<loopback port>`, `ORIGIN=<app publicUrl>`, `<SMA|SRA>_CONFIG=<overlaid file>`.
   `KUBERNETES_SERVICE_*` passes through so SAR keeps working in cluster.
2. Poll `/api/health`; the gate answers `503 Starting` until healthy. Restart on exit with backoff
   (1 s doubling to 30 s). SIGTERM to MultiAdmin is forwarded; `tini` is PID 1 in the image.

Overlays (pure, unit tested, `apps.ts`):

- svelteRedisAdmin: `auth = { plugin: 'header', header, headerGroups, headerRole, headerServers,
trustedProxies: LOOPBACK }`, `Portal = { url: portal publicUrl, label }`, `cookieSecret` kept or derived
  from MultiAdmin's secret (HKDF, label `redisadmin`). `login` left untouched (unused by `header`).
- svelteMyAdmin: on every `Servers[i]` and on `ServerDiscovery.server`: `auth_type: 'signon'`,
  `Signon.identity = { type: 'trusted-header', userHeader, emailHeader, groupsHeader, trustedProxies:
LOOPBACK }` (existing `Signon.authorize` kept), `SignonURL = portal /go/myadmin`, `LogoutURL = portal
/logout`; top-level `TrustedProxies = LOOPBACK`; `Portal`. A `Servers[i]` without `user` fails startup
  with a message naming the server, since `signon` connects with the configured account.

### Minimal child patches (one PR per child repo, identical shape, about 40 lines each)

1. `src/lib/server/config/schema.ts` (+ loader): optional `Portal: { url: string; label?: string }`;
   `url` must parse as `http(s)` URL, otherwise config fails to load. Absent means no link.
2. `src/routes/+layout.server.ts`: add `portal: config.Portal ?? null` (only `{ url, label }`).
3. `src/lib/components/app-shell/top-bar.svelte`: `{#if portal}` an icon button (`LayoutGrid`) plus label,
   `href={portal.url}`, before the user menu; same entry in `user-menu.svelte` for the mobile layout.
4. i18n key `portal.back` in en/fr/es (used when `label` is absent).
5. Tests: schema accepts/rejects; layout returns `null` without `Portal`; one e2e asserting the link.

Nothing else changes in the children: no base path, no auth plugin, no new headers.

### Submodules, release and bundle

- `vendor/svelteMyAdmin`, `vendor/svelteRedisAdmin` submodules, gitlinks pinned at release tags. The
  gitlink is the only record of the pinned version; `build-info.json` (shown in the portal footer) is
  derived at build time by `git -C vendor/<x> describe --tags --exact-match`, never committed.
- `scripts/bundle-update.ts` (`pnpm bundle:update [app] [--to vX.Y.Z]`): `git fetch --tags`, pick the
  highest semver `v*` tag (or `--to`), `git checkout --detach <tag>`, `git add vendor/<x>`, print
  old → new with the child's changelog range. Idempotent: re-running at the latest tag stages nothing.
  It refuses to run with a dirty submodule. It does not commit.
- `Dockerfile` (multi-stage): one build stage per child (`pnpm install --frozen-lockfile && pnpm build &&
pnpm prune --prod`, from the child's own lockfile), one for the portal; runtime `node:24-alpine` + `tini`
  with `/app/build` and `/app/children/<app>/{build,node_modules,package.json}`; `EXPOSE 3000`;
  healthcheck on the portal's `/api/health`, which aggregates the children's.
- `deploy/kubernetes/multiadmin.yaml`: `replicas: 1` (in-memory sessions and tickets), one Service port,
  Ingress with the three hosts, a ServiceAccount whose ClusterRole is the union of the two children's
  documented RBAC (SAR create, discovery list/get).
- CI: build the image on push with `submodules: recursive`.

### Module map (svelteMultiAdmin)

```
src/hooks.server.ts                     init → startChildren; handle → app host or portal
src/lib/server/config/schema.ts         PortalConfig + parse (boundary: JSON → domain types)
src/lib/server/config/loader.ts         MULTIADMIN_CONFIG → PortalConfig (cached, fails fast)
src/lib/server/apps.ts                  APPS registry: id, label, child dir, port, config env var, overlay; IDENTITY_HEADERS
src/lib/server/access.ts                grantsFor (pure)
src/lib/server/auth/index.ts            authenticate, startLogin, finishLogin, logout (dispatch on auth.type)
src/lib/server/auth/oidc.ts             openid-client code flow + PKCE
src/lib/server/auth/local.ts            users file store (scrypt), verify, CRUD for the admin UI
src/lib/server/auth/trusted-header.ts   header identity from trustedProxies peers
src/lib/server/session.ts               session table, signed cookie, tickets
src/lib/server/app-host.ts              appForHost, serveAppHost (gate: cookie/ticket/headers → grants → gateway)
src/lib/server/gateway.ts               proxy one request to a child with scrubbed + injected headers
src/lib/server/children.ts              overlay write, spawn, health, restart
src/lib/server/return-path.ts           safeReturnPath (open-redirect guard, one place)
src/routes/+page.svelte|.server.ts      launcher
src/routes/go/[app]/+server.ts          ticket + redirect
src/routes/login/, auth/callback/, logout/
src/routes/admin/users/                 local user admin (userAdmin grant, local auth only)
src/routes/api/health/+server.ts
scripts/bundle-update.ts
vendor/svelteMyAdmin, vendor/svelteRedisAdmin   (submodules)
```

The longest call chain is `hooks.server.ts → app-host.ts → gateway.ts`.

### Type sketch

```ts
// ---------- apps.ts : the one list of apps ----------
export const APPS = {
	myadmin: {
		label: 'MySQL',
		childDir: '/app/children/myadmin',
		port: 3101,
		configEnv: 'SMA_CONFIG',
		overlay: overlayMyAdmin
	},
	redisadmin: {
		label: 'Redis',
		childDir: '/app/children/redisadmin',
		port: 3102,
		configEnv: 'SRA_CONFIG',
		overlay: overlayRedisAdmin
	}
} as const satisfies Record<string, AppSpec>;

export type AppId = keyof typeof APPS;
export function parseAppId(value: string): AppId | null {
	throw new Error('not implemented');
}

/** The headers MultiAdmin owns. Written into child configs AND scrubbed/set by the gateway. */
export const IDENTITY_HEADERS = {
	user: 'x-multiadmin-user',
	email: 'x-multiadmin-email',
	groups: 'x-multiadmin-groups',
	role: 'x-multiadmin-role',
	servers: 'x-multiadmin-servers'
} as const;

export const LOOPBACK = ['127.0.0.1/32', '::1/128'] as const;

interface AppSpec {
	label: string;
	childDir: string;
	port: number;
	configEnv: 'SMA_CONFIG' | 'SRA_CONFIG';
	/** Pure: operator's child config + portal facts → the config the child is started with. */
	overlay: (childConfig: unknown, ctx: OverlayContext) => Record<string, unknown>;
}

export interface OverlayContext {
	portalUrl: URL;
	portalLabel: string;
	appId: AppId;
	derivedSecret: string; // HKDF(cookieSecret, appId)
}

export function overlayMyAdmin(cfg: unknown, ctx: OverlayContext): Record<string, unknown> {
	// TODO: for each Servers[i] and ServerDiscovery.server: auth_type 'signon', Signon.identity from
	// IDENTITY_HEADERS + LOOPBACK (keep Signon.authorize), SignonURL = portal/go/myadmin,
	// LogoutURL = portal/logout. Top-level TrustedProxies = LOOPBACK. Portal = {url,label}.
	// Throw ConfigError when a server has no `user`.
	throw new Error('not implemented');
}

export function overlayRedisAdmin(cfg: unknown, ctx: OverlayContext): Record<string, unknown> {
	// TODO: auth = {plugin:'header', header/headerGroups/headerRole/headerServers from IDENTITY_HEADERS,
	// trustedProxies: LOOPBACK}; cookieSecret ??= ctx.derivedSecret; Portal = {url,label}.
	throw new Error('not implemented');
}

// ---------- config/schema.ts ----------
export type AuthConfig =
	| {
			type: 'oidc';
			issuer: URL;
			clientId: string;
			clientSecret: string;
			groupsClaim: string;
			scopes: string[];
	  }
	| { type: 'local'; usersFile: string; bootstrapAdmin: string | null }
	| {
			type: 'trusted-header';
			userHeader: string;
			emailHeader: string | null;
			groupsHeader: string | null;
			trustedProxies: readonly Cidr[]; // non-empty, enforced by parse
			logoutUrl: string | null;
	  };

export interface AccessRule {
	match: { group: string } | { user: string } | { email: string }; // '*' allowed in group
	grants: GrantPatch;
}

export interface AppConfig {
	publicUrl: URL; // origin only; host unique across portal + apps (parse enforces)
	childConfigPath: string;
	label: string;
}

export interface PortalConfig {
	publicUrl: URL;
	cookieSecret: string; // >= 32 chars
	sessionTtlSeconds: number; // default 8h
	auth: AuthConfig;
	access: readonly AccessRule[];
	apps: Partial<Record<AppId, AppConfig>>; // omitted app: not spawned, not shown
}

export function parsePortalConfig(raw: unknown): PortalConfig {
	throw new Error('not implemented');
}

// ---------- access.ts ----------
export type RedisRole = 'ro' | 'rw' | 'admin';
export interface RedisGrant {
	role: RedisRole;
	servers: 'all' | readonly number[];
}

export interface Grants {
	myadmin: boolean;
	redisadmin: RedisGrant | null;
	userAdmin: boolean;
}
export type GrantPatch = Partial<{
	myadmin: true;
	redisadmin: { role: RedisRole; servers?: number[] };
	userAdmin: true;
}>;

export interface Identity {
	source: AuthConfig['type'];
	user: string; // stable id, no control chars, no comma
	email: string | null;
	groups: readonly string[]; // used for access rules
	kubeGroups: readonly string[]; // forwarded to children; always [] for source 'local'
}

/** Pure union over matching rules: OR booleans, max role, union servers ('all' absorbs). */
export function grantsFor(identity: Identity, rules: readonly AccessRule[]): Grants {
	throw new Error('not implemented');
}

export interface Principal extends Identity {
	grants: Grants;
	sid: SessionId | null; // null for trusted-header
}

// ---------- session.ts ----------
export type SessionId = string & { readonly __brand: 'SessionId' };
export interface Session {
	sid: SessionId;
	identity: Identity;
	expiresAt: number;
}
export type Ticket = string & { readonly __brand: 'Ticket' };

export const SESSION_COOKIE = 'multiadmin_session';
export const ENTER_PATH = '/__multiadmin/enter'; // reserved on app hosts, never proxied

export function createSession(identity: Identity): Session {
	throw new Error('not implemented');
}
/** Verifies the signature, then looks the sid up (expired or revoked → null). */
export function readSessionCookie(value: string | undefined): Session | null {
	throw new Error('not implemented');
}
export function sessionCookieValue(s: Session): string {
	throw new Error('not implemented');
}
export function revokeSession(sid: SessionId): void {
	throw new Error('not implemented');
}
/** HMAC{sid, app, exp=now+30s, nonce}. */
export function issueTicket(sid: SessionId, app: AppId): Ticket {
	throw new Error('not implemented');
}
/** Valid, unexpired, for this app, nonce unseen → sid; the nonce is then burned. */
export function redeemTicket(ticket: string, app: AppId): SessionId | null {
	throw new Error('not implemented');
}

// ---------- auth/index.ts ----------
/** Portal and app hosts alike: session cookie (oidc/local) or trusted headers. Grants recomputed. */
export function authenticate(event: RequestEvent): Promise<Principal | null> {
	throw new Error('not implemented');
}
export function startLogin(event: RequestEvent, returnPath: string): Promise<Response> {
	throw new Error('not implemented');
}
export function finishLogin(event: RequestEvent): Promise<Response> {
	throw new Error('not implemented');
} // oidc callback, local form
export function logout(event: RequestEvent): Promise<Response> {
	throw new Error('not implemented');
}

// ---------- auth/local.ts ----------
export interface LocalUser {
	username: string;
	passwordHash: string; // scrypt$N$r$p$salt$hash
	groups: string[];
	email: string | null;
	disabled: boolean;
}
/** Sole owner of users.json; atomic write (tmp + rename); in-memory copy reloaded on write. */
export interface LocalUserStore {
	verify(username: string, password: string): Promise<LocalUser | null>;
	get(username: string): LocalUser | null;
	list(): readonly LocalUser[];
	upsert(user: Omit<LocalUser, 'passwordHash'> & { password?: string }): Promise<void>;
	remove(username: string): Promise<void>;
}

// ---------- app-host.ts ----------
export function appForHost(host: string): AppId | null {
	throw new Error('not implemented');
}

/**
 * Gate for an app host:
 * ENTER_PATH → redeemTicket → set host cookie → 303 rd.
 * no principal → GET: 303 portal/go/<app>?rd ; else 401.
 * principal without grant → 403 page linking to the portal.
 * child not healthy → 503.
 * else gateway.
 */
export function serveAppHost(event: RequestEvent, app: AppId): Promise<Response> {
	throw new Error('not implemented');
}

// ---------- gateway.ts ----------
/** Proxies one request to 127.0.0.1:<APPS[app].port>. Strips client-supplied identity, forwarding and
 * hop-by-hop headers and the portal cookie; injects identity from the principal. Streams both ways. */
export function forward(event: RequestEvent, app: AppId, principal: Principal): Promise<Response> {
	throw new Error('not implemented');
}
/** Pure, unit tested: the exact header set a child receives. */
export function upstreamHeaders(
	inbound: Headers,
	app: AppId,
	principal: Principal,
	clientAddress: string
): Headers {
	throw new Error('not implemented');
}

// ---------- children.ts ----------
export type ChildState = 'starting' | 'healthy' | 'restarting' | 'disabled';
/** Idempotent: a second call is a no-op. Never throws on child failure; state reflects it. */
export function startChildren(): Promise<void> {
	throw new Error('not implemented');
}
export function childState(app: AppId): ChildState {
	throw new Error('not implemented');
}
/** Pure: parent env minus denylist plus HOST/PORT/ORIGIN/<configEnv>. */
export function childEnv(
	parent: NodeJS.ProcessEnv,
	app: AppId,
	configFile: string,
	origin: URL
): NodeJS.ProcessEnv {
	throw new Error('not implemented');
}

// ---------- return-path.ts ----------
/** '/x?y' only; rejects '//', '\\', absolute URLs and control chars → '/'. */
export function safeReturnPath(value: string | null): string {
	throw new Error('not implemented');
}
```

### Validation and invariants

- All JSON (portal config, child configs, users file, IdP claims, headers) is parsed at the boundary
  into the types above; inside, `Identity.user` is already validated (no control chars, no comma).
- `PortalConfig` parse rejects: duplicate hosts, an app host equal to the portal host, `trusted-header`
  without `trustedProxies`, `cookieSecret` shorter than 32.
- One owner per state: sessions and tickets (`session.ts`), users file (`auth/local.ts`), child processes
  (`children.ts`), header names (`apps.ts`), app list (`APPS`).

## Synthesis decision

**Base: candidate A** (in-process gateway, trusted headers over loopback, one hostname per app).
It satisfies "same instance" literally, reuses the identity contract both children already ship and
test, and limits child changes to an opt-in `Portal` back-link (about 40 lines each).

**Rejected: candidate B** (MultiAdmin as identity broker issuing signed Ed25519 assertions, children
verify them). It is the stronger security shape (no forgeable header class, so no sidecar-on-loopback
risk) and has a deeper child interface. It loses because it needs a new auth plugin plus a callback route
in each child, a third shared repo/package (`@razvn/portal-auth`) to release in lockstep, and a
`replicas`-agnostic ticket ledger per child. That contradicts "children keep their own life" for the
first version. It stays the planned upgrade path if the sidecar risk becomes real (A's `IDENTITY_HEADERS`
is the single seam to swap).

**Grafted from B:**

- Grants refer to **server names**, not positions in `Servers`. Positions drift when an operator reorders
  a child config. The Redis overlay translates names to the indexes `headerServers` wants, and startup
  fails if a granted name does not exist in the child config (B's `portal check`, done at boot).
  Update `RedisGrant.servers` to `'all' | readonly string[]` accordingly.
- Revocation is "next request" in A (grants recomputed per request, sessions server-side), which beats
  B's 5-minute TTL lag, so nothing is taken from B there.
- Release gate: `bundle:update` also refuses a child checkout whose `package.json` lacks a `portal`
  support marker once the back-link patch ships (cheap guard against bundling a child that ignores
  `Portal`).

**Open for the owner** (they change the plan, not the shape): single hostname instead of three (forces
path-prefix and base-path work in both children), meaning of "Kubernetes mode" (assumed: MultiAdmin behind
oauth2-proxy, `trusted-header`), all-or-nothing MyAdmin access, service-mesh sidecars, and the fact that
neither child has a `v*` tag yet.

## Tradeoffs accepted

- We accept three hostnames (DNS + Ingress rules) in exchange for zero base-path work in the children.
- We accept that any process on the container's loopback (an Istio or other sidecar in the same pod)
  can forge identity to the children, in exchange for reusing their existing trusted-header contract
  unchanged.
- We accept in-memory sessions and tickets, hence `replicas: 1` and a re-login after restart, in
  exchange for instant logout across all hosts and exactly-once tickets with no store.
- We accept proxying through SvelteKit `handle` (an extra hop through `fetch`, `BODY_SIZE_LIMIT=Infinity`
  on the portal, `appDir` + empty `static/` rule) in exchange for one module graph and one config parse.
- We accept that MyAdmin access is all-or-nothing per person (plus Kubernetes SAR), because signon uses
  each server's shared MySQL account and we keep the child patch to the back-link.
- We accept that MultiAdmin overwrites the children's auth keys, so a child config cannot opt out of SSO
  inside the bundle, in exchange for a single source for header names and trusted CIDRs.
- We accept one image carrying three `node_modules` trees in exchange for each child building from its
  own lockfile, untouched.

## Alternatives considered

- **Path prefix (`/myadmin`, `/redisadmin`) on one host.** Simpler DNS and one cookie, but every
  child needs `kit.paths.base` plus about 120 URL rewrites and must keep them correct forever; this
  pushes MultiAdmin's layout decision into both repos. Rejected for the "keep each child's own life"
  requirement.
- **nginx or Caddy + oauth2-proxy in front, MultiAdmin as an `auth_request` endpoint, children in their
  own containers.** The most standard ops shape, and it supports WebSockets and very large bodies
  natively, but it adds two more configured components, templated proxy configs that repeat the header
  names (a hand-synced list), and still needs MultiAdmin for local users. More surface for the same
  behaviour.
- **Signed token handoff to the children (JWT in a cookie on a parent domain).** Removes the loopback
  trust boundary, but each child needs a new auth plugin (JWKS or shared key, expiry, rotation), which is
  the biggest possible child patch.
- **Custom Node server (`server.js` dispatching by Host before SvelteKit's `handler`).** Avoids the
  sirv shadowing and body-limit config, but the gate's session and grant code would have to be bundled
  twice or shared via `globalThis`, splitting ownership of the session table.

## Open questions and risks

- Do the children start publishing `v*` tags? None exist today. Until then, should `bundle:update`
  accept `--to <commit>` on `main`?
- Is "Kubernetes mode" meant to be MultiAdmin behind oauth2-proxy (`trusted-header`, as sketched), or
  should MultiAdmin itself run the OIDC flow against the cluster's IdP and forward groups for SAR? Both
  work; the second only changes `auth.type`.
- Is all-or-nothing access to svelteMyAdmin acceptable, or do you want per-server MyAdmin grants? Those
  need a `headerServers`-like filter in svelteMyAdmin, which is a bigger child patch.
- Are three hostnames acceptable for your deployments (for example `admin.`, `mysql.admin.`,
  `redis.admin.`), or must everything live on one host? One host forces the path-prefix alternative.
- Sidecar risk: will this run in an Istio/Linkerd pod? If yes, should children bind a Unix socket
  instead? That needs a small child change, since a Unix peer has no address to match `trustedProxies`.
- Should Redis's `login` list or MyAdmin's cookie auth be refused outright inside the bundle, or just
  ignored as now?
- After a MultiAdmin restart, local users must sign in again and open app tabs bounce through the
  portal. Acceptable for an admin tool?

## Next implementation step

Write `apps.ts` with `IDENTITY_HEADERS`, both overlays and their unit tests against copies of the two
children's `config.sample.json`, since every other module depends on that contract.
