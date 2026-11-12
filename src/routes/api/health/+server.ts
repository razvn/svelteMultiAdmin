import type { RequestHandler } from './$types';

// TODO: aggregate childState() of every configured app; 503 while any is not healthy.
export const GET: RequestHandler = () => new Response('ok\n');
