<script lang="ts">
	import { resolve } from '$app/paths';
	import BrandMark from './brand-mark.svelte';
	import UserMenu from './user-menu.svelte';
	import LanguageMenu from '#lib/components/i18n/language-menu.svelte';
	import ThemeToggle from '#lib/components/theme-toggle.svelte';

	interface Props {
		user: string;
		email: string | null;
		canAdminUsers: boolean;
	}

	let { user, email, canAdminUsers }: Props = $props();
</script>

<header class="sticky top-0 z-20 shrink-0 bg-background/85 px-4 pt-4 backdrop-blur md:px-6">
	<div
		class="flex h-16 items-center gap-2 rounded-xl border bg-card px-3 shadow-card sm:gap-3 sm:px-4"
	>
		<a href={resolve('/(app)')} class="flex items-center gap-3" aria-label="svelteMultiAdmin home">
			<BrandMark />
			<span class="hidden text-lg font-semibold tracking-tight sm:inline">svelteMultiAdmin</span>
		</a>
		<div class="ms-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
			<LanguageMenu />
			<ThemeToggle />
			<UserMenu {user} {email} {canAdminUsers} />
		</div>
	</div>
</header>
