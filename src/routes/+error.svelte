<script lang="ts">
	import { page } from '$app/state';
	import ErrorCard from '#lib/components/app-shell/error-card.svelte';
	import { useI18n } from '#lib/i18n/index.ts';

	const i18n = useI18n();
	const t = $derived(i18n.t);
</script>

<main class="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
	<ErrorCard status={page.status} message={page.error?.message ?? t('Something went wrong')} />
</main>
