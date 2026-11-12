# svelteMultiAdmin

One portal in front of [svelteMyAdmin](https://github.com/razvn/svelteMyAdmin) and
[svelteRedisAdmin](https://github.com/razvn/svelteRedisAdmin). People sign in once here, then open MySQL or
Redis administration without a second login. Both apps run in the same container, each on its own hostname,
and keep their own repositories: they are git submodules pinned to release tags.

```
browser ──▶ ingress ──▶ MultiAdmin :3000 ── admin.example.com        portal: login, launcher, user admin
                              │          ── mysql.admin.example.com  ── gate ──▶ 127.0.0.1:3101 svelteMyAdmin
                              │          ── redis.admin.example.com  ── gate ──▶ 127.0.0.1:3102 svelteRedisAdmin
                              └─ starts and supervises both children
```

Design, trade-offs and rejected alternatives: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## How it works

1. You sign in on the portal (local users, OIDC, or an SSO proxy in front of it).
2. Access rules (`access` in the config) turn your user and groups into grants: MySQL yes/no, a Redis role
   (`ro`, `rw`, `admin`) and the Redis servers you may see, and whether you manage users.
3. Clicking an app goes through `/go/<app>`: a 30-second single-use ticket sets a cookie on the app's host.
4. The portal proxies every request to the child with trusted identity headers (`x-multiadmin-*`), after
   removing anything of that kind a client sent. The children listen on loopback only and trust those headers
   only from there, so they never show a login form.
5. Each child's user menu has "Back to Admin portal" (its `Portal` config key, set by the portal).

Grants are recomputed on every request: editing `access`, regrouping or disabling a local user applies on the
next click, on every host. Logging out on the portal ends the session on all hosts.

## Configuration

`multiadmin.json` (path in `MULTIADMIN_CONFIG`) is the only file that knows about all three apps.
See [config.sample.json](config.sample.json).

```jsonc
{
	"publicUrl": "https://admin.example.com", // origin only; every host below must be different
	"cookieSecret": "32+ random characters",
	"sessionTtlSeconds": 28800,
	"auth": { "type": "local", "usersFile": "/data/users.json", "bootstrapAdmin": "admin" },
	"access": [
		{
			"match": { "group": "platform-admins" },
			"grants": { "myadmin": true, "redisadmin": { "role": "admin" }, "userAdmin": true }
		},
		{
			"match": { "group": "devs" },
			"grants": { "redisadmin": { "role": "rw", "servers": ["Dev redis1"] } }
		},
		{ "match": { "group": "*" }, "grants": { "redisadmin": { "role": "ro" } } }
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

`myadmin.json` and `redisadmin.json` are the children's normal configs (servers, discovery, audit). The portal
overwrites their authentication keys when it starts the child, so you never write header names or trusted
networks. A MyAdmin server needs an explicit `user` (and `password`): with SSO everyone shares that account,
narrowed by the child's Kubernetes checks if configured.

### Access rules

A rule matches one of `group` (`"*"` is everyone), `user` or `email`, and adds grants. Matching rules are
merged: `myadmin` if any grants it, the highest Redis role, and the union of Redis servers (a rule with no
`servers` means all of them). Redis servers are named by their `name` in the Redis config, not by position. An
unknown name grants nothing. `userAdmin` only works with local auth.

### Authentication modes

| `auth.type`      | Who signs in                                    | Notes                                                                                                                                                                                                                                                          |
| ---------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local`          | Users stored in `usersFile`                     | scrypt hashes, 5 failed logins per user per 5 minutes locks that user. First start creates `bootstrapAdmin` from `MULTIADMIN_BOOTSTRAP_PASSWORD` (groups: `MULTIADMIN_BOOTSTRAP_GROUPS`, default `platform-admins`).                                           |
| `oidc`           | Any OpenID Connect provider                     | `issuer`, `clientId`, `clientSecret` or `clientSecretEnv`, `groupsClaim` (default `groups`), `scopes`. Redirect URI to register: `<publicUrl>/auth/callback`. `allowInsecureIssuer` allows an `http://` issuer for development only. Groups are read at login. |
| `trusted-header` | An SSO proxy (oauth2-proxy, ingress `auth-url`) | Reads `userHeader`, `emailHeader`, `groupsHeader` on every request, only when the TCP peer is in `trustedProxies`. The proxy must cover all three hosts (cookie on the parent domain). `logoutUrl` is where "Log out" goes.                                    |

Groups of OIDC and trusted-header users are also passed to the children as Kubernetes groups (for their
SubjectAccessReview checks). Local users' groups are not, so a local admin cannot mint `system:masters`.

## Deployment

- **Hostnames:** three DNS names pointing at one Service port and one Ingress. For local development
  `*.localhost` resolves to loopback in browsers: `portal.localhost`, `myadmin.localhost`, `redisadmin.localhost`.
- **One replica:** sessions and tickets are in memory, so run `replicas: 1`. A restart signs everyone out.
- **Proxy headers:** the portal derives its origin from `x-forwarded-proto` and `x-forwarded-host`
  (`PROTOCOL_HEADER`/`HOST_HEADER`, set in the Dockerfile). Without them SvelteKit assumes `https` and every
  form POST is refused as cross-site. Do not set `ADDRESS_HEADER`: the identity checks rely on the real TCP peer.
- **Uploads:** the portal runs with `BODY_SIZE_LIMIT=Infinity`. A child keeps its own default; raise it with
  `MULTIADMIN_MYADMIN_BODY_SIZE_LIMIT` or `MULTIADMIN_REDISADMIN_BODY_SIZE_LIMIT`.
- **Not for sidecars you do not trust:** anything else listening on the pod's loopback can send identity
  headers to a child. See the trade-offs in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- **Kubernetes:** [deploy/kubernetes](deploy/kubernetes/README.md) has a ready manifest (RBAC for both apps' discovery and access checks, config, accounts volume, one-replica Deployment, Service, three-host Ingress) and a local walkthrough.

```sh
git submodule update --init          # fetch both children
docker build -t multiadmin .
docker run -p 3000:3000 \
  -v ./multiadmin.json:/config/multiadmin.json -v ./myadmin.json:/config/myadmin.json \
  -v ./redisadmin.json:/config/redisadmin.json -v multiadmin-data:/data \
  -e MULTIADMIN_BOOTSTRAP_PASSWORD=change-me multiadmin
```

| Variable                                    | Meaning                                                              |
| ------------------------------------------- | -------------------------------------------------------------------- |
| `MULTIADMIN_CONFIG`                         | Path of `multiadmin.json` (required).                                |
| `MULTIADMIN_CHILDREN_DIR`                   | Where `<app>/build` live (default `/app/children`); for development. |
| `MULTIADMIN_BOOTSTRAP_PASSWORD` / `_GROUPS` | First local admin.                                                   |
| `MULTIADMIN_<APP>_BODY_SIZE_LIMIT`          | Upload limit of one child.                                           |

## Updating the bundled apps

The children are git submodules in `vendor/`, pinned to release tags.

```sh
pnpm bundle:update                    # both apps to their newest v* tag (adds the submodules the first time)
pnpm bundle:update redisadmin --to v0.3.1   # one app, a specific tag (also to go back)
pnpm bundle:update --dry-run
git diff --cached && git commit       # the script only stages
```

It fetches tags, picks the highest semver `v*` release (pre-releases and other tags are ignored), checks it
out, stages the new pin and prints the commits between. It refuses a submodule with local changes and says so
when a repository has no release tag yet. Run again at the latest tag it changes nothing. It warns when a
child has no `Portal` key (no back-link).

## Development

```sh
pnpm install
pnpm test           # unit and integration tests (real child processes, real git, a fake OIDC provider)
pnpm check          # svelte-check
pnpm lint           # prettier + eslint
pnpm build
```

To run the whole thing locally, build both children, symlink their repositories as
`<dir>/myadmin` and `<dir>/redisadmin`, and start the portal:

```sh
MULTIADMIN_CONFIG=./multiadmin.json MULTIADMIN_CHILDREN_DIR=<dir> \
MULTIADMIN_BOOTSTRAP_PASSWORD=change-me PROTOCOL_HEADER=x-forwarded-proto \
PORT=3000 node build
```

A browser does not send `x-forwarded-proto`, so for plain http put a small proxy in front that adds
`x-forwarded-proto: http` (or use https).

## Interface

The portal looks like the two apps (same shadcn-svelte components, theme tokens, light/dark/system theme,
login layout, top bar) and speaks English, French and Spanish: the same gettext-style catalogs as
svelteRedisAdmin, in `src/lib/i18n/locales/<lang>/<area>.json`, with English msgids as keys. A test fails when
a string of the source is missing from a catalog. The language is remembered in the `multiadmin_lang` cookie.

## Status

Done: local, OIDC and trusted-header sign-in, user admin, launcher, gate and proxy, child supervision, access
rules, the `Portal` back-link in both children, `bundle:update`, interface and translations, Kubernetes manifest.
Not done: OIDC logout does not end the provider's session. The portal has no audit log of its own: the apps log
every action with the person's name from the portal, which is what the audit needs. The children have no release
tags yet, so nothing can be pinned until they are tagged.

## License

GPL-2.0-or-later, like the apps it bundles. See [LICENSE](LICENSE).
