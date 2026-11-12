import { spawn, type ChildProcess } from 'node:child_process';
import { hkdfSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APPS, type AppId } from '#lib/server/apps.ts';
import { getPortalConfig, type PortalConfig } from '#lib/server/config/schema.ts';

export type ChildState = 'starting' | 'healthy' | 'restarting' | 'disabled';

export interface StartOptions {
	/** Directory holding `<app>/build`. Default: MULTIADMIN_CHILDREN_DIR, else each `APPS[app].childDir`. */
	childrenDir?: string;
	/** Loopback port per app. Default: `APPS[app].port`. */
	ports?: Partial<Record<AppId, number>>;
	/** Restart backoff. Default 1s doubling to 30s. */
	backoffMs?: { initial: number; max: number };
	/** Health poll interval. Default 500ms. */
	pollMs?: number;
	/** Parent environment the children inherit from. Default: process.env. */
	env?: NodeJS.ProcessEnv;
}

interface Child {
	app: AppId;
	port: number;
	state: ChildState;
	proc: ChildProcess | null;
	stopped: boolean;
	/** `name`s of the child's `Servers`, in order (Redis grants name servers; the child wants positions). */
	serverNames: string[];
	timer: NodeJS.Timeout | null;
}

/** Names the parent env must not leak into a child: they would move or spoof the peer, origin or config. */
const DENIED_ENV = new Set([
	'ADDRESS_HEADER',
	'XFF_DEPTH',
	'ORIGIN',
	'PROTOCOL_HEADER',
	'HOST_HEADER',
	'PORT_HEADER',
	'HOST',
	'PORT',
	'SOCKET_PATH',
	'BODY_SIZE_LIMIT',
	'SMA_CONFIG',
	'SRA_CONFIG'
]);
const DENIED_PREFIXES = ['MULTIADMIN_', 'OIDC_'];

/**
 * Pure: parent env minus the denylist, plus HOST=127.0.0.1, PORT, ORIGIN=<app publicUrl> and
 * <configEnv>=<configFile>. KUBERNETES_SERVICE_* passes through. A child's upload limit is its own:
 * `MULTIADMIN_<APP>_BODY_SIZE_LIMIT` becomes its `BODY_SIZE_LIMIT`.
 */
export function childEnv(
	parent: NodeJS.ProcessEnv,
	app: AppId,
	configFile: string,
	origin: URL,
	port: number
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(parent)) {
		if (DENIED_ENV.has(name) || DENIED_PREFIXES.some((p) => name.startsWith(p))) continue;
		env[name] = value;
	}
	const limit = parent[`MULTIADMIN_${app.toUpperCase()}_BODY_SIZE_LIMIT`];
	if (limit) env['BODY_SIZE_LIMIT'] = limit;
	env['HOST'] = '127.0.0.1';
	env['PORT'] = String(port);
	env['ORIGIN'] = origin.origin;
	env[APPS[app].configEnv] = configFile;
	return env;
}

interface Running {
	children: Map<AppId, Child>;
	stop(): Promise<void>;
}

let running: Promise<Running> | undefined;
let current: Map<AppId, Child> = new Map();

/**
 * Sole owner of child processes. Idempotent (a second call returns the first). Writes each overlaid config
 * to a private temp dir (0600), spawns `node <dir>/build`, polls /api/health, restarts with backoff.
 * Never throws on child failure: a child whose config cannot be overlaid is `disabled` and logged.
 */
export function startChildren(config?: PortalConfig, options: StartOptions = {}): Promise<void> {
	running ??= Promise.resolve(launch(config ?? getPortalConfig(), options));
	return running.then(() => undefined);
}

/** Stops every child and forgets them (SIGTERM of the portal, tests). */
export async function stopChildren(): Promise<void> {
	const r = await running;
	running = undefined;
	current = new Map();
	await r?.stop();
}

export function childState(app: AppId): ChildState {
	return current.get(app)?.state ?? 'disabled';
}

export function childPort(app: AppId): number | null {
	return current.get(app)?.port ?? null;
}

/** `Servers[].name` of the Redis child, in order, for translating grants into positions. */
export function redisServerNames(): readonly string[] {
	return current.get('redisadmin')?.serverNames ?? [];
}

function launch(config: PortalConfig, options: StartOptions): Running {
	const parentEnv = options.env ?? process.env;
	const backoff = options.backoffMs ?? { initial: 1000, max: 30_000 };
	const pollMs = options.pollMs ?? 500;
	const dir = mkdtempSync(join(tmpdir(), 'multiadmin-')); // created 0700
	const children = new Map<AppId, Child>();
	current = children;

	for (const id of Object.keys(config.apps) as AppId[]) {
		const entry = config.apps[id]!;
		const port = options.ports?.[id] ?? APPS[id].port;
		const child: Child = {
			app: id,
			port,
			state: 'disabled',
			proc: null,
			stopped: false,
			serverNames: [],
			timer: null
		};
		children.set(id, child);

		let configFile: string;
		try {
			const overlaid = APPS[id].overlay(JSON.parse(readFileSync(entry.config, 'utf8')), {
				portalUrl: config.publicUrl,
				portalLabel: 'Admin portal',
				appId: id,
				derivedSecret: Buffer.from(
					hkdfSync('sha256', config.cookieSecret, '', `multiadmin:${id}`, 32)
				).toString('base64url')
			});
			const servers = overlaid['Servers'];
			if (Array.isArray(servers)) {
				child.serverNames = servers.map((s) => (typeof s?.name === 'string' ? s.name : ''));
			}
			configFile = join(dir, `${id}.json`);
			writeFileSync(configFile, JSON.stringify(overlaid), { mode: 0o600 });
		} catch (caught) {
			console.error(`[multiadmin] ${id} disabled: ${(caught as Error).message}`);
			continue;
		}

		const env = childEnv(parentEnv, id, configFile, entry.publicUrl, port);
		const childrenDir = options.childrenDir ?? parentEnv['MULTIADMIN_CHILDREN_DIR'];
		const appDir = childrenDir ? join(childrenDir, id) : APPS[id].childDir;
		let delay = backoff.initial;

		const run = (): void => {
			if (child.stopped) return;
			child.state = child.state === 'disabled' ? 'starting' : 'restarting';
			const proc = spawn(process.execPath, [join(appDir, 'build')], {
				cwd: appDir,
				env,
				stdio: ['ignore', 'pipe', 'pipe']
			});
			child.proc = proc;
			proc.stdout?.on('data', (d: Buffer) => process.stdout.write(prefix(id, d)));
			proc.stderr?.on('data', (d: Buffer) => process.stderr.write(prefix(id, d)));
			proc.on('error', (e) => console.error(`[multiadmin] ${id} cannot start: ${e.message}`));
			proc.on('exit', (code, signal) => {
				if (child.proc === proc) child.proc = null;
				if (child.stopped) return;
				console.error(`[multiadmin] ${id} exited (${signal ?? code}); restarting in ${delay}ms`);
				child.state = 'restarting';
				child.timer = setTimeout(run, delay);
				delay = Math.min(delay * 2, backoff.max);
			});
			void waitHealthy(proc);
		};

		const waitHealthy = async (proc: ChildProcess): Promise<void> => {
			while (!child.stopped && child.proc === proc) {
				try {
					const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
						signal: AbortSignal.timeout(2000)
					});
					if (res.ok) {
						if (child.proc === proc) {
							child.state = 'healthy';
							delay = backoff.initial;
						}
						return;
					}
				} catch {
					// not listening yet
				}
				await new Promise((r) => setTimeout(r, pollMs));
			}
		};

		run();
	}

	const onSignal = (): void => void stopChildren().finally(() => process.exit(0));
	process.once('SIGTERM', onSignal);
	process.once('SIGINT', onSignal);

	return {
		children,
		async stop() {
			process.off('SIGTERM', onSignal);
			process.off('SIGINT', onSignal);
			await Promise.all(
				[...children.values()].map(async (c) => {
					c.stopped = true;
					if (c.timer) clearTimeout(c.timer);
					const proc = c.proc;
					if (!proc || proc.exitCode !== null) return;
					await new Promise<void>((resolve) => {
						proc.once('exit', () => resolve());
						proc.kill('SIGTERM');
					});
				})
			);
		}
	};
}

function prefix(app: AppId, data: Buffer): string {
	return data
		.toString()
		.split('\n')
		.filter((line, i, all) => line !== '' || i < all.length - 1)
		.map((line) => `[${app}] ${line}\n`)
		.join('');
}
