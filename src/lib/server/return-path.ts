/** Open-redirect guard, the one place: '/x?y' only; anything else -> '/'. */
export function safeReturnPath(value: string | null): string {
	if (!value || !value.startsWith('/')) return '/';
	if (value.startsWith('//') || value.includes('\\')) return '/';
	if (/\p{Cc}/u.test(value)) return '/';
	return value;
}
