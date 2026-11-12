<script lang="ts">
	import LogIn from '@lucide/svelte/icons/log-in';
	import { resolve } from '$app/paths';
	import BrandMark from '#lib/components/app-shell/brand-mark.svelte';
	import LanguageMenu from '#lib/components/i18n/language-menu.svelte';
	import ThemeToggle from '#lib/components/theme-toggle.svelte';
	import { Alert, AlertDescription } from '#lib/components/ui/alert/index.ts';
	import { Button, buttonVariants } from '#lib/components/ui/button/index.ts';
	import * as Card from '#lib/components/ui/card/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { Label } from '#lib/components/ui/label/index.ts';
	import { useI18n } from '#lib/i18n/index.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const i18n = useI18n();
	const t = $derived(i18n.t);

	let submitting = $state(false);
</script>

<svelte:head><title>{t('Sign in')} - svelteMultiAdmin</title></svelte:head>

<!-- Split layout: gradient brand panel (logo on a white liseré) + sign-in card, like its apps. -->
<main
	class="grid min-h-screen bg-background text-foreground lg:grid-cols-[1fr_minmax(26rem,32rem)]"
>
	<div
		class="relative hidden flex-col items-center justify-center gap-8 overflow-hidden bg-gradient-to-br from-primary to-violet-600 p-10 lg:flex"
		data-testid="brand-panel"
	>
		<div
			aria-hidden="true"
			class="absolute -top-16 -left-16 h-64 w-64 rotate-12 rounded-3xl bg-white/10"
		></div>
		<div
			aria-hidden="true"
			class="absolute -right-20 -bottom-24 h-80 w-80 -rotate-6 rounded-3xl bg-black/10"
		></div>
		<div
			class="relative rounded-3xl border-2 border-white/90 bg-white/10 p-8 shadow-2xl backdrop-blur-xs"
			data-testid="brand-tile"
		>
			<BrandMark class="size-28 rounded-2xl" />
		</div>
		<div class="relative flex flex-col items-center gap-2 text-center">
			<p class="text-2xl font-semibold tracking-tight text-white">svelteMultiAdmin</p>
			<p class="max-w-64 text-sm text-white/80">
				{t('One sign-in for your MySQL and Redis administration.')}
			</p>
		</div>
	</div>

	<div class="relative flex flex-col items-center justify-center gap-6 p-4 sm:p-8">
		<div class="absolute end-4 top-4 flex items-center gap-1">
			<LanguageMenu />
			<ThemeToggle />
		</div>

		<a
			href={resolve('/(app)')}
			class="flex items-center gap-3 lg:hidden"
			aria-label="svelteMultiAdmin home"
		>
			<BrandMark />
			<span class="text-lg font-semibold tracking-tight">svelteMultiAdmin</span>
		</a>

		<h1 class="sr-only">{t('Sign in')}</h1>

		<Card.Root class="w-full max-w-sm gap-0 py-0">
			<Card.Header class="border-b py-5">
				<Card.Title>{t('Sign in')}</Card.Title>
				<Card.Description>
					{data.authType === 'oidc'
						? t('Use your organization account.')
						: t('Use your portal account.')}
				</Card.Description>
			</Card.Header>
			<Card.Content class="p-5">
				{#if data.authType === 'oidc'}
					<a
						href={resolve(`/auth/login?rd=${encodeURIComponent(data.rd)}`)}
						class={buttonVariants({ class: 'w-full' })}
						data-testid="oidc-login"
					>
						<LogIn />
						{t('Sign in with your organization account')}
					</a>
				{:else}
					<form
						method="POST"
						class="flex flex-col gap-4"
						onsubmit={() => (submitting = true)}
						data-testid="login-form"
					>
						{#if form?.error}
							<Alert variant="destructive" data-testid="login-error">
								<AlertDescription>{form.error}</AlertDescription>
							</Alert>
						{/if}
						<div class="flex flex-col gap-2">
							<Label for="username">{t('Username')}</Label>
							<Input
								id="username"
								name="username"
								value={form?.username ?? ''}
								autocomplete="username"
								required
							/>
						</div>
						<div class="flex flex-col gap-2">
							<Label for="password">{t('Password')}</Label>
							<Input
								id="password"
								name="password"
								type="password"
								autocomplete="current-password"
								required
							/>
						</div>
						<Button type="submit" class="w-full" disabled={submitting}>
							<LogIn />
							{submitting ? t('Signing in…') : t('Sign in')}
						</Button>
					</form>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>
</main>
