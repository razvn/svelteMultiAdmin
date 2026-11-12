<script lang="ts">
	import '../app.css';
	import favicon from '#lib/assets/favicon.svg';
	import { ModeWatcher } from 'mode-watcher';
	import { I18n, setI18n } from '#lib/i18n/index.ts';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	const i18n = new I18n(() => data);
	setI18n(i18n);

	// Keep <html lang dir> in sync after a client-side language switch (SSR sets them via app.html).
	$effect(() => {
		document.documentElement.lang = i18n.locale;
		document.documentElement.dir = i18n.dir;
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<ModeWatcher />

{@render children()}
