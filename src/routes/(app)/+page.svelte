<script lang="ts">
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import Database from '@lucide/svelte/icons/database';
	import Layers from '@lucide/svelte/icons/layers';
	import LayoutGrid from '@lucide/svelte/icons/layout-grid';
	import { resolve } from '$app/paths';
	import PageHeader from '#lib/components/app-shell/page-header.svelte';
	import * as Alert from '#lib/components/ui/alert/index.ts';
	import { buttonVariants } from '#lib/components/ui/button/index.ts';
	import * as Card from '#lib/components/ui/card/index.ts';
	import { useI18n } from '#lib/i18n/index.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const i18n = useI18n();
	const t = $derived(i18n.t);

	// One entry per bundled app; the server only sends the ones this person may open.
	const details = $derived({
		myadmin: { icon: Database, text: t('Browse and manage MySQL and MariaDB databases.') },
		redisadmin: { icon: Layers, text: t('Browse keys and run commands on Redis servers.') }
	});
</script>

<svelte:head><title>{t('Applications')} - svelteMultiAdmin</title></svelte:head>

<PageHeader
	title={t('Applications')}
	description={t('Choose an application to open. You stay signed in.')}
	icon={LayoutGrid}
/>

{#if data.apps.length === 0}
	<Alert.Root data-testid="no-apps">
		<Alert.Description>{t('You do not have access to any application yet.')}</Alert.Description>
	</Alert.Root>
{:else}
	<div class="grid gap-4 sm:grid-cols-2">
		{#each data.apps as app (app.id)}
			{@const Icon = details[app.id].icon}
			<Card.Root data-testid="app-{app.id}">
				<Card.Header>
					<div class="flex items-center gap-3">
						<span
							aria-hidden="true"
							class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary"
						>
							<Icon class="size-5" />
						</span>
						<Card.Title>{app.label}</Card.Title>
					</div>
					<Card.Description>{details[app.id].text}</Card.Description>
				</Card.Header>
				<Card.Footer>
					<a href={resolve('/go/[app]', { app: app.id })} class={buttonVariants()}>
						{t('Open')}
						<ArrowRight />
					</a>
				</Card.Footer>
			</Card.Root>
		{/each}
	</div>
{/if}
