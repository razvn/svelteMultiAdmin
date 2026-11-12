import { describe, expect, it } from 'vitest';
import { safeReturnPath } from './return-path.ts';

describe('safeReturnPath', () => {
	it('keeps local paths with a query', () => {
		expect(safeReturnPath('/server/1?x=2')).toBe('/server/1?x=2');
	});
	it.each([null, '', 'https://evil.test', '//evil.test', '/\\evil', '/a\nb', 'relative'])(
		'falls back to / for %j',
		(value) => {
			expect(safeReturnPath(value)).toBe('/');
		}
	);
});
