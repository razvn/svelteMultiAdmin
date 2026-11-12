<script lang="ts">
	import { cn, type WithElementRef } from '#lib/utils.ts';
	import type { HTMLTdAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLTdAttributes> = $props();
</script>

<td
	bind:this={ref}
	data-slot="table-cell"
	class={cn(
		'px-4 py-3 align-middle whitespace-nowrap first:ps-5 last:pe-5 [&:has([role=checkbox])]:pe-0',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</td>
