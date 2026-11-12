import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/** AES-256-GCM sealed JSON for short-lived cookies (OIDC flow state). Key derived from the cookie secret. */
export function seal(secret: string, label: string, value: unknown): string {
	const key = Buffer.from(hkdfSync('sha256', secret, '', `multiadmin:seal:${label}`, 32));
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
	return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

/** Null for anything that was not produced by `seal` with the same secret and label. */
export function unseal<T>(secret: string, label: string, token: string | undefined): T | null {
	if (!token) return null;
	try {
		const raw = Buffer.from(token, 'base64url');
		if (raw.length < 29) return null;
		const key = Buffer.from(hkdfSync('sha256', secret, '', `multiadmin:seal:${label}`, 32));
		const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
		decipher.setAuthTag(raw.subarray(12, 28));
		const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
		return JSON.parse(plain.toString('utf8')) as T;
	} catch {
		return null;
	}
}
