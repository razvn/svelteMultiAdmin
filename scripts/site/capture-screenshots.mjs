/**
 * pnpm site:screenshots
 *
 * Captures the screenshots of the presentation site (site/assets/screenshots) from a running portal with its
 * two apps. Env: SITE_PORTAL (default http://portal.localhost:3000), SITE_USER / SITE_PASSWORD (a user with
 * every grant), SITE_FORWARD_PROTO (set to `http` when the portal runs with PROTOCOL_HEADER=x-forwarded-proto on
 * plain http, which a browser does not send by itself). Each page is captured in light and dark, in English,
 * in a throwaway browser context. Needs `pnpm exec playwright install chromium` once.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const PORTAL = (process.env.SITE_PORTAL ?? 'http://portal.localhost:3000').replace(/\/$/, '');
const USER = process.env.SITE_USER ?? 'admin';
const PASSWORD = process.env.SITE_PASSWORD;
const OUT = join(import.meta.dirname, '..', '..', 'site', 'assets', 'screenshots');

if (!PASSWORD) {
	console.error('Set SITE_PASSWORD (and SITE_USER) to an account of the running portal.');
	process.exit(1);
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();

for (const scheme of /** @type {const} */ (['light', 'dark'])) {
	const context = await browser.newContext({
		viewport: { width: 1440, height: 900 },
		deviceScaleFactor: 1.5,
		colorScheme: scheme,
		locale: 'en-US',
		extraHTTPHeaders: process.env.SITE_FORWARD_PROTO
			? { 'x-forwarded-proto': process.env.SITE_FORWARD_PROTO }
			: {}
	});
	// The apps theme themselves from mode-watcher's localStorage key, not the media query alone.
	await context.addInitScript((mode) => {
		try {
			localStorage.setItem('mode-watcher-mode', mode);
		} catch {
			/* storage may be unavailable; the colorScheme still helps */
		}
	}, scheme);
	const page = await context.newPage();

	const shot = async (/** @type {string} */ name) => {
		await page.evaluate(() => document.fonts.ready);
		await page.waitForTimeout(500);
		await page.screenshot({ path: join(OUT, `${name}-${scheme}.png`), type: 'png' });
		console.log(`${name}-${scheme}.png`);
	};
	const openUserMenu = async () => {
		await page.getByRole('button', { name: 'User menu' }).click();
		await page.getByRole('menuitem', { name: /Back to/ }).waitFor();
	};

	await page.goto(`${PORTAL}/login`, { waitUntil: 'networkidle' });
	await shot('login');

	await page.getByLabel('Username').fill(USER);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await page.waitForURL(`${PORTAL}/`);
	await page.getByRole('heading', { name: 'Applications' }).waitFor();
	await shot('launcher');

	await page.goto(`${PORTAL}/admin/users`, { waitUntil: 'networkidle' });
	await shot('users');

	// Through the portal into each app: no second login, and the way back in the user menu.
	await page.goto(`${PORTAL}/go/redisadmin`, { waitUntil: 'networkidle' });
	await page.getByRole('button', { name: 'User menu' }).waitFor();
	await openUserMenu();
	await shot('redis');

	await page.goto(`${PORTAL}/go/myadmin`, { waitUntil: 'networkidle' });
	await page.getByRole('button', { name: 'User menu' }).waitFor();
	await openUserMenu();
	await shot('mysql');

	await context.close();
}
await browser.close();
