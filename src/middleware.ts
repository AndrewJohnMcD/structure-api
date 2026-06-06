import { Context, Next } from 'hono';
import { Env } from './types';

export async function corsMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const allowedOrigins = c.env.ALLOWED_ORIGINS.split(',').map(o => o.trim());
  const origin = c.req.header('Origin') || '';

  if (allowedOrigins.includes(origin)) {
    c.header('Access-Control-Allow-Origin', origin);
  }

  c.header('Access-Control-Allow-Methods', 'POST, GET, DELETE, PATCH, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Secret');
  c.header('Access-Control-Max-Age', '86400');

  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204);
  }

  await next();
}

/**
 * Admin authentication middleware.
 * Requires X-Admin-Secret header matching the ADMIN_SECRET environment variable.
 * Applied to all tenant provisioning endpoints.
 */
export async function adminAuth(c: Context<{ Bindings: Env }>, next: Next) {
  const provided = c.req.header('X-Admin-Secret');

  if (!provided || provided !== c.env.ADMIN_SECRET) {
    return c.json({ error: 'Unauthorized: invalid or missing admin secret' }, 401);
  }

  await next();
}
