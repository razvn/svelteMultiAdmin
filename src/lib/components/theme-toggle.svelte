<script lang="ts">
	import { resetMode, setMode, mode, userPrefersMode } from 'mode-watcher';
	import SunIcon from '@lucide/svelte/icons/sun';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.ts';
	import { useI18n } from '#lib/i18n/index.ts';

	const i18n = useI18n();
	const t = $derived(i18n.t);
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="ghost"
				size="icon"
				class="rounded-full"
				aria-label={t('Toggle theme')}
			>
				{#if mode.current === 'dark'}
					<MoonIcon />
				{:else}
					<SunIcon />
				{/if}
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end">
		<DropdownMenu.RadioGroup
			value={userPrefersMode.current}
			onValueChange={(value) => {
				if (value === 'system') resetMode();
				else setMode(value === 'dark' ? 'dark' : 'light');
			}}
		>
			<DropdownMenu.RadioItem value="light">{t('Light')}</DropdownMenu.RadioItem>
			<DropdownMenu.RadioItem value="dark">{t('Dark')}</DropdownMenu.RadioItem>
			<DropdownMenu.RadioItem value="system">{t('System')}</DropdownMenu.RadioItem>
		</DropdownMenu.RadioGroup>
	</DropdownMenu.Content>
</DropdownMenu.Root>
