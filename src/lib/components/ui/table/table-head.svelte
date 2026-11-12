<script lang="ts">
	import { cn, type WithElementRef } from '#lib/utils.ts';
	import type { HTMLThAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLThAttributes> = $props();
</script>

<th
	bind:this={ref}
	data-slot="table-head"
	class={cn(
		'h-11 px-4 text-left align-middle text-xs font-semibold whitespace-nowrap text-muted-foreground first:ps-5 last:pe-5 [&:has([role=checkbox])]:pe-0',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</th>
