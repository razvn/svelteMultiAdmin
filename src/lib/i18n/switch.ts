import { refreshAll } from '$app/navigation';

/**
 * Switch the interface language: the server stores the choice in the `multiadmin_lang` cookie, then every load function re-runs and the UI re-renders translated.
 */
export async function setLanguage(code: string): Promise<boolean> {
	const res = await fetch('/api/lang', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ lang: code })
	});
	if (!res.ok) return false;
	await refreshAll();
	return true;
}
