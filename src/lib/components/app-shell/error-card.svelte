<script lang="ts">
	import { resolve } from '$app/paths';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import * as Alert from '#lib/components/ui/alert/index.ts';
	import { buttonVariants } from '#lib/components/ui/button/index.ts';
	import * as Card from '#lib/components/ui/card/index.ts';
	import { useI18n } from '#lib/i18n/index.ts';

	interface Props {
		status: number;
		message: string;
	}

	let { status, message }: Props = $props();

	const i18n = useI18n();
	const t = $derived(i18n.t);

	const title = $derived(
		status === 404
			? t('Not found')
			: status === 401
				? t('Sign in required')
				: status === 403
					? t('Forbidden')
					: status >= 500
						? t('Server error')
						: t('Something went wrong')
	);
</script>

<Card.Root class="w-full max-w-md gap-0 py-0" data-testid="error-card">
	<Card.Header class="border-b py-5">
		<Card.Title>{status} · {title}</Card.Title>
	</Card.Header>
	<Card.Content class="flex flex-col gap-4 p-5">
		<Alert.Root variant="destructive">
			<CircleAlert />
			<Alert.Description>{message}</Alert.Description>
		</Alert.Root>
		<a href={resolve('/(app)')} class={buttonVariants({ variant: 'outline' })}
			>{t('Back to the portal')}</a
		>
	</Card.Content>
</Card.Root>
