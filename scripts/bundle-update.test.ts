import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundleUpdate, type AppSource } from './bundle-update.ts';
import { compareSemver, parseTag, pickLatest } from './bundle-lib.ts';

describe('release selection', () => {
	it('parses only v-prefixed semver tags', () => {
		expect(parseTag('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, pre: [] });
		expect(parseTag('v1.2.3-rc.1')?.pre).toEqual(['rc', '1']);
		for (const bad of ['1.2.3', 'latest', 'v1.2', 'v1.2.3.4', 'release-v1.2.3', 'main'])
			expect(parseTag(bad)).toBeNull();
	});
	it('orders numerically (v0.10.0 beats v0.9.0) and puts a release above its pre-releases', () => {
		expect(pickLatest(['v0.9.0', 'v0.10.0', 'v0.2.0'])).toBe('v0.10.0');
		expect(pickLatest(['v1.0.0-rc.1', 'v1.0.0', 'v0.9.0'])).toBe('v1.0.0');
		expect(compareSemver(parseTag('v1.0.0-alpha.2')!, parseTag('v1.0.0-alpha.10')!)).toBeLessThan(
			0
		);
		expect(compareSemver(parseTag('v1.0.0-alpha')!, parseTag('v1.0.0-alpha.1')!)).toBeLessThan(0);
		expect(compareSemver(parseTag('v1.0.0-1')!, parseTag('v1.0.0-a')!)).toBeLessThan(0);
	});
	it('ignores pre-releases and junk unless nothing else exists and they are allowed', () => {
		expect(pickLatest(['v1.0.0-rc.1', 'nightly'])).toBeNull();
		expect(pickLatest(['v1.0.0-rc.1', 'nightly'], true)).toBe('v1.0.0-rc.1');
		expect(pickLatest([])).toBeNull();
	});
});

const ENV = {
	...process.env,
	GIT_AUTHOR_NAME: 't',
	GIT_AUTHOR_EMAIL: 't@example.com',
	GIT_COMMITTER_NAME: 't',
	GIT_COMMITTER_EMAIL: 't@example.com',
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_SYSTEM: '/dev/null'
};
const git = (cwd: string, ...args: string[]) =>
	execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();

function commit(repo: string, file: string, content: string, tag?: string) {
	writeFileSync(join(repo, file), content);
	git(repo, 'add', '-A');
	git(repo, 'commit', '-q', '-m', `change ${content}`);
	if (tag) git(repo, 'tag', tag);
}

describe('bundleUpdate (real git, local repositories)', () => {
	const base = mkdtempSync(join(tmpdir(), 'ma-bundle-'));
	const child = join(base, 'child');
	const root = join(base, 'multi');
	for (const d of [child, root]) {
		mkdirSync(d);
		git(d, 'init', '-q', '-b', 'main');
	}
	const sources = {
		myadmin: { dir: 'vendor/svelteMyAdmin', url: child } satisfies AppSource,
		redisadmin: { dir: 'vendor/svelteRedisAdmin', url: join(base, 'missing') } satisfies AppSource
	};
	const opts = {
		root,
		apps: ['myadmin'] as const,
		sources,
		gitArgs: ['-c', 'protocol.file.allow=always'],
		log: () => {}
	};
	const staged = () => git(root, 'diff', '--cached', '--name-only');
	const pinned = () => git(join(root, sources.myadmin.dir), 'describe', '--tags', '--exact-match');

	it('says so when the child has no release tag yet', async () => {
		commit(child, 'a.txt', '1');
		const [o] = await bundleUpdate(opts);
		expect(o).toMatchObject({
			status: 'error',
			message: expect.stringMatching(/no v\* release tag/)
		});
	});

	it('adds the submodule and pins the highest release (semver, not lexical), staging without committing', async () => {
		for (const [i, tag] of ['v0.2.0', 'v0.9.0', 'v0.10.0', 'v0.11.0-rc.1', 'latest'].entries())
			commit(child, 'a.txt', `t${i}`, tag);
		const [o] = await bundleUpdate(opts);
		expect(o).toMatchObject({ status: 'updated', to: 'v0.10.0' });
		expect(pinned()).toBe('v0.10.0');
		expect(staged().split('\n')).toEqual(
			expect.arrayContaining(['.gitmodules', 'vendor/svelteMyAdmin'])
		);
		expect(git(root, 'rev-list', '--all', '--count')).toBe('0'); // staged only, never committed
	});

	it('is idempotent at the latest tag', async () => {
		const before = git(root, 'diff', '--cached');
		const [o] = await bundleUpdate(opts);
		expect(o).toMatchObject({ status: 'unchanged', to: 'v0.10.0' });
		expect(git(root, 'diff', '--cached')).toBe(before);
	});

	it('moves to a new release, supports --to (also going back), and --dry-run changes nothing', async () => {
		commit(child, 'a.txt', 'new', 'v0.12.0');
		const dry = await bundleUpdate({ ...opts, dryRun: true });
		expect(dry[0]).toMatchObject({
			status: 'updated',
			message: expect.stringMatching(/would move/)
		});
		expect(pinned()).toBe('v0.10.0');
		expect((await bundleUpdate(opts))[0]).toMatchObject({ status: 'updated', to: 'v0.12.0' });
		expect(pinned()).toBe('v0.12.0');
		expect((await bundleUpdate({ ...opts, to: 'v0.2.0' }))[0]).toMatchObject({
			status: 'updated',
			to: 'v0.2.0'
		});
		expect(pinned()).toBe('v0.2.0');
	});

	it('refuses an unknown or non-release --to, and a dirty submodule', async () => {
		expect((await bundleUpdate({ ...opts, to: 'v9.9.9' }))[0]).toMatchObject({
			status: 'error',
			message: expect.stringMatching(/not a v\* release tag/)
		});
		expect((await bundleUpdate({ ...opts, to: 'latest' }))[0].status).toBe('error');
		writeFileSync(join(root, sources.myadmin.dir, 'a.txt'), 'local edit');
		expect((await bundleUpdate(opts))[0]).toMatchObject({
			status: 'error',
			message: expect.stringMatching(/local changes/)
		});
		expect(pinned()).toBe('v0.2.0');
	});

	it('explains when the root is not a git repository', async () => {
		await expect(
			bundleUpdate({ ...opts, root: mkdtempSync(join(tmpdir(), 'ma-nogit-')) })
		).rejects.toThrow(/git init/);
	});

	it('reports a failing app without stopping the others', async () => {
		const outcomes = await bundleUpdate({ ...opts, apps: ['redisadmin', 'myadmin'] });
		expect(outcomes.map((o) => o.app)).toEqual(['redisadmin', 'myadmin']);
		expect(outcomes[0]!.status).toBe('error');
	});
});
