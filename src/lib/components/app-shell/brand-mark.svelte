<script lang="ts">
	import logo from '#lib/assets/logo.svg';
	import { cn } from '#lib/utils.ts';

	interface Props {
		class?: string;
	}

	let { class: className }: Props = $props();
</script>

<!-- App logo: indigo tile with a 2x2 grid of app tiles. -->
<img src={logo} alt="" aria-hidden="true" class={cn('size-9 shrink-0 shadow-xs', className)} />
