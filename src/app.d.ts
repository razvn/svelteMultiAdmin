import type { Principal } from '#lib/server/access.ts';
import type { Translator } from '#lib/i18n/translator.ts';

declare global {
	namespace App {
		interface Locals {
			/** Set on the portal host only; app hosts are handled before routes run. */
			principal: Principal | null;
			locale: string;
			/** Translator bound to `locale` (server-side `t()` in loads, actions and gate pages). */
			i18n: Translator;
		}
	}
}

export {};
