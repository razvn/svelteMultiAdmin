<script lang="ts">
	import TopBar from '#lib/components/app-shell/top-bar.svelte';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
</script>

<div class="flex min-h-screen flex-col bg-background text-foreground">
	<TopBar {...data.me} />
	<main class="mx-auto flex w-full max-w-5xl min-w-0 flex-1 flex-col gap-6 p-4 md:p-6">
		{@render children()}
	</main>
</div>
