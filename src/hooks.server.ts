import type { Handle, ServerInit } from '@sveltejs/kit/hooks';
import { startChildren } from '#lib/server/children.ts';
import { appForHost, serveAppHost } from '#lib/server/app-host.ts';
import { authenticate } from '#lib/server/auth/index.ts';
import { applyLocale, fillHtmlLang } from '#lib/server/i18n/locale.ts';

export const init: ServerInit = () => startChildren();

export const handle: Handle = async ({ event, resolve }) => {
	// Language first: the app-host gate renders its own small pages too.
	await applyLocale(event);
	const app = appForHost(event.url.host);
	if (app) return serveAppHost(event, app); // gate + proxy; never reaches SvelteKit routes
	event.locals.principal = await authenticate(event); // portal host
	return resolve(event, {
		transformPageChunk: ({ html }) => fillHtmlLang(html, event.locals.locale)
	});
};
