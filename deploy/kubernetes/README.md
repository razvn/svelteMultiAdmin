# Kubernetes example

One pod runs the portal and both apps. svelteMyAdmin and svelteRedisAdmin find the databases of every review
namespace (one per merge request), connect with the password from that namespace's Secret, and let Kubernetes
RBAC decide who may use which one. The portal decides who may open which app at all. The references are
[svelteRedisAdmin's docs/KUBERNETES.md](https://github.com/razvn/svelteRedisAdmin/blob/main/docs/KUBERNETES.md)
and [svelteMyAdmin's docs/SIGNON.md](https://github.com/razvn/svelteMyAdmin/blob/main/docs/SIGNON.md).

| File              | What                                                                                                                                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `multiadmin.yaml` | Namespace `tools`: ServiceAccount, RBAC for SubjectAccessReviews and discovery (both apps), the portal config (Secret), the apps' discovery config (ConfigMap), a PVC for the local accounts, Deployment, Service, Ingress. |

The review environments to discover are the ones of the apps' own examples:
`svelteRedisAdmin/deploy/kubernetes/review-example.yaml` and `svelteMyAdmin/deploy/kubernetes/review-example.yaml`.

## Try it on a local cluster

Rancher Desktop with the `moby` engine, or any cluster that can run an image you built locally. From the repository
root, with the submodules fetched (`git submodule update --init`, or `pnpm bundle:update` the first time):

```bash
docker build -t multiadmin:dev .
```

```bash
kubectl apply -f deploy/kubernetes/multiadmin.yaml
```

```bash
kubectl -n tools rollout status deploy/multiadmin
```

The portal tells its three hostnames apart by `Host`, and `*.localhost` resolves to the loopback address in a
browser, so a port-forward is enough:

```bash
kubectl -n tools port-forward svc/multiadmin 8080:80
```

Open `http://portal.localhost:8080`. The browser does not send `X-Forwarded-Proto`, which the portal needs to
tell it is plain http; for this local try-out add the header with a request-header extension (ModHeader, for
example) on `*.localhost`, or use an Ingress controller with a certificate.

Sign in as `admin` with the bootstrap password of the Secret, then add accounts on the Users page. Give a person
the group `platform-admins` for everything, or `devs` for read-only Redis.

```bash
kubectl -n tools logs deploy/multiadmin
```

Clean up:

```bash
kubectl delete -f deploy/kubernetes/multiadmin.yaml
```

## Going to production

- **Change every secret.** `cookieSecret` (32+ random characters), `blowfish_secret`, the bootstrap password.
  Keep the apps' config in a Secret too if it has static servers with passwords.
- **Real names and TLS.** Set the three `publicUrl` values and the Ingress hosts. They must be different, and
  the Ingress must send `x-forwarded-proto` and `x-forwarded-host`.
- **Prefer SSO.** Switch `auth` to `oidc` (register `<publicUrl>/auth/callback` at your provider), or to
  `trusted-header` behind oauth2-proxy with `trustedProxies` set to the proxy's addresses. In both, the groups
  of the person also reach the apps for their Kubernetes checks: `authorize.userPrefix` and `groupsPrefix` must
  equal the API server's `--oidc-username-prefix` and `--oidc-groups-prefix`, or RBAC denies everyone.
- **One replica, Recreate.** Sessions and tickets are in memory: everyone signs in again after a restart.
- **Nothing else in the pod.** The apps trust the portal's identity headers from the pod's loopback address
  only. Do not add sidecars (a service mesh proxy, for example) you do not trust.
- **Narrow the Secret rights if needed.** The ClusterRoleBinding lets the portal read `redis-auth` and
  `mysql-auth` in every namespace. Bind `multiadmin-discovery` with a RoleBinding per review namespace instead,
  from the pipeline that creates it.
- **Use your registry.** Push the image there, and drop `imagePullPolicy: Never`.
