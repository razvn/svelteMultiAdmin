# svelteMultiAdmin bundle: portal + svelteMyAdmin + svelteRedisAdmin in one image.
# Build with submodules checked out: git submodule update --init

FROM node:24-alpine AS portal
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.0.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod --ignore-scripts

FROM node:24-alpine AS myadmin
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.0.0 --activate
COPY vendor/svelteMyAdmin/package.json vendor/svelteMyAdmin/pnpm-lock.yaml vendor/svelteMyAdmin/.npmrc ./
RUN pnpm install --frozen-lockfile
COPY vendor/svelteMyAdmin/ .
RUN pnpm build && pnpm prune --prod --ignore-scripts

FROM node:24-alpine AS redisadmin
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.0.0 --activate
COPY vendor/svelteRedisAdmin/package.json vendor/svelteRedisAdmin/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY vendor/svelteRedisAdmin/ .
RUN pnpm build && pnpm prune --prod --ignore-scripts

FROM node:24-alpine
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 BODY_SIZE_LIMIT=Infinity \
	# Behind the ingress: origin = x-forwarded-proto + x-forwarded-host, or every form POST fails the CSRF check.
	PROTOCOL_HEADER=x-forwarded-proto HOST_HEADER=x-forwarded-host \
	MULTIADMIN_CONFIG=/config/multiadmin.json
COPY --from=portal /app/package.json ./
COPY --from=portal /app/node_modules ./node_modules
COPY --from=portal /app/build ./build
COPY --from=myadmin /app/package.json /app/children/myadmin/package.json
COPY --from=myadmin /app/node_modules /app/children/myadmin/node_modules
COPY --from=myadmin /app/build /app/children/myadmin/build
COPY --from=redisadmin /app/package.json /app/children/redisadmin/package.json
COPY --from=redisadmin /app/node_modules /app/children/redisadmin/node_modules
COPY --from=redisadmin /app/build /app/children/redisadmin/build
USER 1000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "build"]
