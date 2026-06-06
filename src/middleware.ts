import { Context, Next } from 'hono';
import { Env } from './types';

export async function corsMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const allowedOrigins = c.env.ALLOWED_ORIGINS.split(',').map(o => o.trim());
  const origin = c.req.header('Origin') || '';

  if (allowedOrigins.includes(origin)) {
    c.header('Access-Control-Allow-Origin', origin);
  }

  c.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  c.header('Access-Control-Max-Age', '86400');

  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204);
  }

  await next();
}
