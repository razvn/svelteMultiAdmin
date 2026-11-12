import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface LocalUser {
	/** Lowercase, `[a-z0-9._@-]`, so it is always a safe header value and a stable key. */
	username: string;
	/** scrypt$N$r$p$salt$hash (base64url) */
	passwordHash: string;
	groups: string[];
	email: string | null;
	disabled: boolean;
}

/** What the admin screen edits. `password` is required for a new user, optional (keep) for an existing one. */
export interface LocalUserInput {
	username: string;
	groups: string[];
	email: string | null;
	disabled: boolean;
	password?: string;
}

/** Sole owner of users.json: atomic write (tmp + rename, 0600), in-memory copy, writes serialized. */
export interface LocalUserStore {
	/** Null for an unknown, disabled or wrong-password user; all take the same time. */
	verify(username: string, password: string): Promise<LocalUser | null>;
	get(username: string): LocalUser | null;
	list(): readonly LocalUser[];
	upsert(user: LocalUserInput): Promise<void>;
	remove(username: string): Promise<void>;
}

/** `message` is an English msgid for the admin screen to translate with `params`. */
export class LocalUserError extends Error {
	override name = 'LocalUserError';
	constructor(
		message: string,
		readonly params: Record<string, string | number> = {}
	) {
		super(message);
	}
}

const N = 16384;
const R = 8;
const P = 1;
const USERNAME = /^[a-z0-9][a-z0-9._@-]{0,63}$/;
const MIN_PASSWORD = 8;

const scryptAsync = (password: string, salt: Buffer, keylen: number, options: ScryptOptions) =>
	new Promise<Buffer>((resolve, reject) =>
		scrypt(password, salt, keylen, options, (error, key) => (error ? reject(error) : resolve(key)))
	);

export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16);
	const hash = await scryptAsync(password, salt, 32, { N, r: R, p: P });
	return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const [kind, n, r, p, salt, hash] = stored.split('$');
	if (kind !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
	const expected = Buffer.from(hash, 'base64url');
	const actual = await scryptAsync(password, Buffer.from(salt, 'base64url'), expected.length, {
		N: Number(n),
		r: Number(r),
		p: Number(p)
	});
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Compared against when the user does not exist, so a miss costs the same as a wrong password. */
let decoy: Promise<string> | undefined;

function cleanInput(input: LocalUserInput): Omit<LocalUserInput, 'password'> {
	const username = input.username.trim().toLowerCase();
	if (!USERNAME.test(username)) {
		throw new LocalUserError(
			'Username: 1-64 characters of a-z, 0-9, ".", "_", "@", "-", starting with a letter or digit.'
		);
	}
	const groups = [...new Set(input.groups.map((g) => g.trim()).filter(Boolean))];
	for (const group of groups) {
		if (/[,\p{Cc}]/u.test(group))
			throw new LocalUserError('Group "{group}": no commas or control characters.', { group });
	}
	const email = input.email?.trim() || null;
	if (email !== null && (/[\p{Cc}\s,]/u.test(email) || !email.includes('@')))
		throw new LocalUserError('Email looks invalid.');
	return { username, groups, email, disabled: input.disabled };
}

export interface OpenOptions {
	/** For the bootstrap admin: MULTIADMIN_BOOTSTRAP_PASSWORD and MULTIADMIN_BOOTSTRAP_GROUPS. */
	env?: Record<string, string | undefined>;
}

export async function openLocalUserStore(
	usersFile: string,
	bootstrapAdmin: string | null,
	options: OpenOptions = {}
): Promise<LocalUserStore> {
	const env = options.env ?? process.env;
	const users = new Map<string, LocalUser>();
	try {
		const parsed = JSON.parse(await readFile(usersFile, 'utf8')) as { users?: LocalUser[] };
		for (const user of parsed.users ?? []) users.set(user.username, user);
	} catch (caught) {
		if ((caught as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw new LocalUserError(`cannot read ${usersFile}: ${(caught as Error).message}`);
		}
	}

	let writing: Promise<void> = Promise.resolve();
	const persist = (): Promise<void> => {
		const snapshot = JSON.stringify(
			{ users: [...users.values()].sort((a, b) => a.username.localeCompare(b.username)) },
			null,
			'\t'
		);
		writing = writing.then(async () => {
			await mkdir(dirname(usersFile), { recursive: true });
			const tmp = `${usersFile}.${process.pid}.tmp`;
			await writeFile(tmp, snapshot, { mode: 0o600 });
			await rename(tmp, usersFile);
		});
		return writing;
	};

	const store: LocalUserStore = {
		async verify(username, password) {
			const user = users.get(username.trim().toLowerCase());
			decoy ??= hashPassword('multiadmin-decoy');
			const ok = await verifyPassword(password, user?.passwordHash ?? (await decoy));
			return user && ok && !user.disabled ? user : null;
		},
		get: (username) => users.get(username.trim().toLowerCase()) ?? null,
		list: () => [...users.values()].sort((a, b) => a.username.localeCompare(b.username)),
		async upsert(input) {
			const clean = cleanInput(input);
			const existing = users.get(clean.username);
			if (input.password !== undefined && input.password !== '') {
				if (input.password.length < MIN_PASSWORD)
					throw new LocalUserError('Password: at least {n} characters.', { n: MIN_PASSWORD });
			} else if (!existing) {
				throw new LocalUserError('A new user needs a password.');
			}
			const passwordHash = input.password
				? await hashPassword(input.password)
				: existing!.passwordHash;
			users.set(clean.username, { ...clean, passwordHash });
			await persist();
		},
		async remove(username) {
			if (users.delete(username.trim().toLowerCase())) await persist();
		}
	};

	if (bootstrapAdmin !== null && !store.get(bootstrapAdmin)) {
		const password = env['MULTIADMIN_BOOTSTRAP_PASSWORD'];
		if (!password) {
			throw new LocalUserError(
				`bootstrapAdmin "${bootstrapAdmin}" does not exist yet: set MULTIADMIN_BOOTSTRAP_PASSWORD to create it`
			);
		}
		const groups = (env['MULTIADMIN_BOOTSTRAP_GROUPS'] ?? 'platform-admins').split(',');
		await store.upsert({
			username: bootstrapAdmin,
			groups,
			email: null,
			disabled: false,
			password
		});
	}
	return store;
}
