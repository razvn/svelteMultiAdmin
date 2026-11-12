<script lang="ts">
	import type { Component, Snippet } from 'svelte';

	interface Props {
		title: string;
		description?: string;
		/** Optional leading icon rendered in a tinted square. */
		icon?: Component;
		/** Right-aligned buttons / controls. */
		actions?: Snippet;
		/** Extra content below the title (badges, links). */
		children?: Snippet;
		/** Heading level: pages use the h1; nested headers inside a page can pass 2. */
		level?: 1 | 2;
	}

	let { title, description, icon: Icon, actions, children, level = 1 }: Props = $props();
</script>

<header class="flex flex-wrap items-start justify-between gap-x-4 gap-y-3" data-slot="page-header">
	<div class="flex min-w-0 items-center gap-3">
		{#if Icon}
			<span
				aria-hidden="true"
				class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary"
			>
				<Icon class="size-5" />
			</span>
		{/if}
		<div class="min-w-0">
			<svelte:element
				this={level === 1 ? 'h1' : 'h2'}
				class="text-2xl leading-8 font-semibold tracking-tight text-foreground"
			>
				{title}
			</svelte:element>
			{#if description}
				<p class="mt-0.5 text-sm text-muted-foreground">{description}</p>
			{/if}
			{@render children?.()}
		</div>
	</div>
	{#if actions}
		<div class="flex flex-wrap items-center gap-2">{@render actions()}</div>
	{/if}
</header>
