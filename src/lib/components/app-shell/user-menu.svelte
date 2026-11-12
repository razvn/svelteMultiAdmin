<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import LogOut from '@lucide/svelte/icons/log-out';
	import UsersIcon from '@lucide/svelte/icons/users';
	import { resolve } from '$app/paths';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.ts';
	import { useI18n } from '#lib/i18n/index.ts';

	interface Props {
		user: string;
		email: string | null;
		canAdminUsers: boolean;
	}

	let { user, email, canAdminUsers }: Props = $props();

	const i18n = useI18n();
	const t = $derived(i18n.t);

	const initials = $derived(user.slice(0, 2).toUpperCase() || '?');
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				type="button"
				aria-label={t('User menu')}
				class="flex h-10 items-center gap-2.5 rounded-full py-1 ps-1 pe-1 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 sm:pe-3"
			>
				<span
					aria-hidden="true"
					class="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
				>
					{initials}
				</span>
				<span class="hidden max-w-48 truncate text-sm font-medium sm:block" data-testid="user-name">
					{user}
				</span>
				<ChevronDown class="hidden size-4 text-muted-foreground sm:block" aria-hidden="true" />
			</button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end" class="w-64">
		<DropdownMenu.Label class="flex flex-col gap-0.5 font-normal">
			<span class="truncate text-sm font-semibold">{user}</span>
			{#if email}<span class="truncate text-xs text-muted-foreground">{email}</span>{/if}
		</DropdownMenu.Label>
		{#if canAdminUsers}
			<DropdownMenu.Separator />
			<DropdownMenu.Item>
				{#snippet child({ props })}
					<a {...props} href={resolve('/(app)/admin/users')}>
						<UsersIcon />
						{t('Users')}
					</a>
				{/snippet}
			</DropdownMenu.Item>
		{/if}
		<DropdownMenu.Separator />
		<form method="POST" action="/logout" class="contents">
			<DropdownMenu.Item>
				{#snippet child({ props })}
					<button {...props} type="submit" class="{props.class} w-full">
						<LogOut />
						{t('Log out')}
					</button>
				{/snippet}
			</DropdownMenu.Item>
		</form>
	</DropdownMenu.Content>
</DropdownMenu.Root>
