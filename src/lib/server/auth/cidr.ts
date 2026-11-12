import { BlockList, isIP } from 'node:net';

/** `::ffff:10.0.0.1` (an IPv4 peer on a dual-stack socket) -> `10.0.0.1`. */
function unmapIpv4(address: string): string {
	const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
	return match ? match[1]! : address;
}

/** A matcher for IPs and CIDR ranges (already validated by the config schema). */
export function peerMatcher(ranges: readonly string[]): (peer: string | null) => boolean {
	const list = new BlockList();
	for (const range of ranges) {
		const [raw, bits] = range.split('/');
		const address = bits === undefined ? unmapIpv4(raw!) : raw!;
		const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
		if (bits === undefined) list.addAddress(address, family);
		else list.addSubnet(address, Number(bits), family);
	}
	return (peer) => {
		if (!peer) return false;
		const address = unmapIpv4(peer);
		const family = isIP(address);
		return family !== 0 && list.check(address, family === 6 ? 'ipv6' : 'ipv4');
	};
}

/**
 * The real client: walking `X-Forwarded-For` from the right while the hop is a trusted proxy, the first address
 * that is not one. A peer outside `ranges` is the client itself (its header is ignored, anyone can send it).
 */
export function clientAddress(
	ranges: readonly string[],
	peer: string | null,
	forwardedFor: string | null
): string | null {
	const trusted = peerMatcher(ranges);
	if (!trusted(peer) || !forwardedFor) return peer && unmapIpv4(peer);
	const hops = forwardedFor
		.split(',')
		.map((hop) => unmapIpv4(hop.trim()))
		.filter((hop) => isIP(hop) !== 0);
	let client = peer && unmapIpv4(peer);
	for (let i = hops.length - 1; i >= 0; i--) {
		client = hops[i]!;
		if (!trusted(client)) break;
	}
	return client;
}
