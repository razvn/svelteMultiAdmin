// pnpm bundle:update [myadmin|redisadmin] [--to vX.Y.Z] [--dry-run]
//
// Moves vendor/<app> (a git submodule of the child's own repo) to its highest `v*` release tag, or to `--to`, and
// stages the new gitlink in this repo. It never commits: review `git diff --cached`, then commit. Idempotent: at the
// requested tag it changes nothing. Adds the submodule first when it is not there yet. Refuses a dirty submodule.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { APPS } from '../src/lib/server/apps.ts';
import { parseTag, pickLatest } from './bundle-lib.ts';

const run = promisify(execFile);

type AppId = keyof typeof APPS;

export interface AppSource {
	/** Submodule path, relative to the repo root. */
	dir: string;
	url: string;
}

export const SOURCES = {
	myadmin: { dir: 'vendor/svelteMyAdmin', url: 'https://github.com/razvn/svelteMyAdmin.git' },
	redisadmin: {
		dir: 'vendor/svelteRedisAdmin',
		url: 'https://github.com/razvn/svelteRedisAdmin.git'
	}
} as const satisfies Record<AppId, AppSource>;

export interface UpdateOptions {
	/** The svelteMultiAdmin checkout. */
	root: string;
	apps?: readonly AppId[];
	/** Pin this tag instead of the latest (also how to go back). */
	to?: string;
	dryRun?: boolean;
	sources?: Record<AppId, AppSource>;
	/** Extra `git -c ...` arguments (tests allow file:// submodules). */
	gitArgs?: readonly string[];
	log?: (line: string) => void;
}

export interface Outcome {
	app: AppId;
	status: 'updated' | 'unchanged' | 'error';
	from: string | null;
	to: string | null;
	message: string;
}

export async function bundleUpdate(options: UpdateOptions): Promise<Outcome[]> {
	const { root, dryRun = false, to } = options;
	const sources = options.sources ?? SOURCES;
	const log = options.log ?? ((line: string) => console.log(line));
	const git = async (cwd: string, ...args: string[]) =>
		(
			await run('git', [...(options.gitArgs ?? []), ...args], { cwd, maxBuffer: 16 * 1024 * 1024 })
		).stdout.trim();

	try {
		await git(root, 'rev-parse', '--git-dir');
	} catch {
		throw new Error(
			`${root} is not a git repository: run "git init" there first (submodules need one)`
		);
	}

	const outcomes: Outcome[] = [];
	for (const app of options.apps ?? (Object.keys(APPS) as AppId[])) {
		const { dir, url } = sources[app];
		const path = join(root, dir);
		const done = (o: Omit<Outcome, 'app'>) => {
			outcomes.push({ app, ...o });
			log(`${app}: ${o.message}`);
		};
		try {
			if (!existsSync(join(path, '.git'))) {
				if (dryRun) {
					done({
						status: 'error',
						from: null,
						to: null,
						message: `${dir} is not checked out; run without --dry-run to add it`
					});
					continue;
				}
				const registered = await git(
					root,
					'config',
					'--file',
					'.gitmodules',
					'--get',
					`submodule.${dir}.url`
				).catch(() => '');
				if (registered) await git(root, 'submodule', 'update', '--init', '--', dir);
				else await git(root, 'submodule', 'add', url, dir);
			}
			if (await git(path, 'status', '--porcelain')) {
				done({
					status: 'error',
					from: null,
					to: null,
					message: `${dir} has local changes; commit or discard them first`
				});
				continue;
			}
			await git(path, 'fetch', '--tags', '--force', 'origin');
			const tags = (await git(path, 'tag', '--list', 'v*')).split('\n').filter(Boolean);
			const target = to ?? pickLatest(tags);
			if (!target) {
				done({
					status: 'error',
					from: null,
					to: null,
					message: 'no v* release tag in the repository yet; nothing to pin (tag a release first)'
				});
				continue;
			}
			if (!tags.includes(target) || !parseTag(target)) {
				done({
					status: 'error',
					from: null,
					to: null,
					message: `${target} is not a v* release tag of the repository`
				});
				continue;
			}
			const head = await git(path, 'rev-parse', 'HEAD');
			const wanted = await git(path, 'rev-parse', `${target}^{commit}`);
			const current =
				(await git(path, 'describe', '--tags', '--exact-match').catch(() => '')) ||
				head.slice(0, 12);
			if (head === wanted) {
				done({ status: 'unchanged', from: current, to: target, message: `already at ${target}` });
				continue;
			}
			const range = await git(
				path,
				'log',
				'--oneline',
				'--no-decorate',
				`${head}..${wanted}`
			).catch(() => '');
			if (dryRun) {
				done({
					status: 'updated',
					from: current,
					to: target,
					message: `would move ${current} -> ${target}`
				});
			} else {
				await git(path, 'checkout', '--detach', target);
				await git(root, 'add', dir);
				done({
					status: 'updated',
					from: current,
					to: target,
					message: `${current} -> ${target} (staged, not committed)`
				});
			}
			if (range)
				log(
					range
						.split('\n')
						.map((line) => `  ${line}`)
						.join('\n')
				);
			const schema = join(path, 'src/lib/server/config/schema.ts');
			if (!dryRun && existsSync(schema) && !readFileSync(schema, 'utf8').includes('Portal')) {
				log(
					`  warning: ${target} has no "Portal" config key, so its user menu has no back-link to this portal`
				);
			}
		} catch (caught) {
			done({
				status: 'error',
				from: null,
				to: null,
				message: (caught as Error).message.split('\n')[0]!
			});
		}
	}
	return outcomes;
}

function parseArgs(argv: string[]): Pick<UpdateOptions, 'apps' | 'to' | 'dryRun'> {
	const known = Object.keys(APPS) as AppId[];
	const apps: AppId[] = [];
	let to: string | undefined;
	let dryRun = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === '--dry-run') dryRun = true;
		else if (arg === '--to') to = argv[++i];
		else if ((known as string[]).includes(arg)) apps.push(arg as AppId);
		else
			throw new Error(
				`unknown argument "${arg}" (apps: ${known.join(', ')}; flags: --to vX.Y.Z, --dry-run)`
			);
	}
	if (to !== undefined && apps.length !== 1) throw new Error('--to needs exactly one app');
	return { ...(apps.length ? { apps } : {}), ...(to ? { to } : {}), dryRun };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const root = resolve(fileURLToPath(import.meta.url), '../..');
	try {
		const outcomes = await bundleUpdate({ root, ...parseArgs(process.argv.slice(2)) });
		process.exitCode = outcomes.some((o) => o.status === 'error') ? 1 : 0;
	} catch (caught) {
		console.error((caught as Error).message);
		process.exitCode = 2;
	}
}
