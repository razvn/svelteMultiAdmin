<script lang="ts">
	import UserPlus from '@lucide/svelte/icons/user-plus';
	import UsersIcon from '@lucide/svelte/icons/users';
	import { enhance } from '$app/forms';
	import PageHeader from '#lib/components/app-shell/page-header.svelte';
	import * as Alert from '#lib/components/ui/alert/index.ts';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as Card from '#lib/components/ui/card/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { Label } from '#lib/components/ui/label/index.ts';
	import * as Table from '#lib/components/ui/table/index.ts';
	import { useI18n } from '#lib/i18n/index.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const i18n = useI18n();
	const t = $derived(i18n.t);
</script>

<svelte:head><title>{t('Users')} - svelteMultiAdmin</title></svelte:head>

<PageHeader
	title={t('Users')}
	description={t('Local accounts of this portal. Groups decide the access rules that apply.')}
	icon={UsersIcon}
/>

{#if form?.error}
	<Alert.Root variant="destructive" data-testid="users-error">
		<Alert.Description>{form.error}</Alert.Description>
	</Alert.Root>
{:else if form && 'saved' in form}
	<Alert.Root variant="success" data-testid="users-saved">
		<Alert.Description>{t('Saved {name}.', { name: form.saved ?? '' })}</Alert.Description>
	</Alert.Root>
{/if}

<Card.Root class="gap-0 py-0">
	<Card.Header class="border-b py-5"><Card.Title>{t('Accounts')}</Card.Title></Card.Header>
	<Card.Content class="px-0">
		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head>{t('Username')}</Table.Head>
					<Table.Head>{t('Groups')}</Table.Head>
					<Table.Head>{t('Email')}</Table.Head>
					<Table.Head>{t('Status')}</Table.Head>
					<Table.Head class="text-end"><span class="sr-only">{t('Actions')}</span></Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each data.users as user (user.username)}
					<Table.Row data-testid="user-{user.username}">
						<Table.Cell class="font-medium">{user.username}</Table.Cell>
						<Table.Cell class="whitespace-normal">
							<span class="flex flex-wrap gap-1">
								{#each user.groups as group (group)}<Badge variant="muted">{group}</Badge>{/each}
							</span>
						</Table.Cell>
						<Table.Cell class="text-muted-foreground">{user.email ?? ''}</Table.Cell>
						<Table.Cell>
							{#if user.disabled}
								<Badge variant="destructive">{t('Disabled')}</Badge>
							{:else}
								<Badge variant="success">{t('Active')}</Badge>
							{/if}
						</Table.Cell>
						<Table.Cell class="text-end">
							{#if user.username !== data.me}
								<form method="POST" action="?/remove" use:enhance class="inline">
									<input type="hidden" name="username" value={user.username} />
									<Button type="submit" variant="outline" size="sm">{t('Delete')}</Button>
								</form>
							{/if}
						</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</Card.Content>
</Card.Root>

<Card.Root class="gap-0 py-0">
	<Card.Header class="border-b py-5">
		<Card.Title>{t('Add or update a user')}</Card.Title>
		<Card.Description
			>{t("Leave the password empty to keep an existing user's password.")}</Card.Description
		>
	</Card.Header>
	<Card.Content class="p-5">
		<form method="POST" action="?/save" use:enhance class="grid gap-4 sm:grid-cols-2">
			<div class="flex flex-col gap-2">
				<Label for="username">{t('Username')}</Label>
				<Input id="username" name="username" value={form?.username ?? ''} required />
			</div>
			<div class="flex flex-col gap-2">
				<Label for="password">{t('Password')}</Label>
				<Input id="password" name="password" type="password" autocomplete="new-password" />
			</div>
			<div class="flex flex-col gap-2">
				<Label for="groups">{t('Groups (comma separated)')}</Label>
				<Input id="groups" name="groups" />
			</div>
			<div class="flex flex-col gap-2">
				<Label for="email">{t('Email')}</Label>
				<Input id="email" name="email" type="email" />
			</div>
			<label class="flex items-center gap-2 text-sm sm:col-span-2">
				<input type="checkbox" name="disabled" class="size-4 accent-primary" />
				{t('Disabled')}
			</label>
			<div class="sm:col-span-2">
				<Button type="submit"><UserPlus />{t('Save')}</Button>
			</div>
		</form>
	</Card.Content>
</Card.Root>
