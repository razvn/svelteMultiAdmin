<script lang="ts">
	import Languages from '@lucide/svelte/icons/languages';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { languageLabel, useI18n } from '#lib/i18n/index.ts';
	import { setLanguage } from '#lib/i18n/switch.ts';

	const i18n = useI18n();
	const t = $derived(i18n.t);

	async function changeLanguage(code: string) {
		if (code !== i18n.locale) await setLanguage(code);
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="ghost"
				size="icon"
				class="rounded-full"
				aria-label={t('Change language')}
				title={languageLabel(i18n.language)}
			>
				<Languages />
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end">
		<DropdownMenu.Label>{t('Language')}</DropdownMenu.Label>
		<DropdownMenu.RadioGroup value={i18n.locale} onValueChange={changeLanguage}>
			{#each i18n.languages as l (l.code)}
				<DropdownMenu.RadioItem value={l.code}>{languageLabel(l)}</DropdownMenu.RadioItem>
			{/each}
		</DropdownMenu.RadioGroup>
	</DropdownMenu.Content>
</DropdownMenu.Root>
