import { Hono } from 'hono';
import { Env } from './types';
import { corsMiddleware } from './middleware';
import { checkout } from './routes/checkout';
import { billing } from './routes/billing';
import { enterprise } from './routes/enterprise';
import { contact } from './routes/contact';
import { referral } from './routes/referral';
import { affiliate } from './routes/affiliate';
import { tenants } from './routes/tenants';
import { support } from './routes/support';
import { webhooks } from './routes/webhooks';
import { customer } from './routes/customer';

const app = new Hono<{ Bindings: Env }>();

// Mount webhook route BEFORE CORS middleware.
// Stripe sends server-to-server requests with no Origin header.
// While our CORS middleware won't block originless requests,
// mounting webhooks first ensures zero middleware interference
// with signature verification and raw body parsing.
app.route('/api/webhooks/stripe', webhooks);

// Apply CORS to all remaining routes
app.use('*', corsMiddleware);

// Health check
app.get('/api/health', (c) => {
  return c.json({
    status: 'operational',
    service: 'structure-api',
    timestamp: new Date().toISOString(),
  });
});

// Mount route modules
app.route('/api/checkout', checkout);
app.route('/api/billing-portal', billing);
app.route('/api/enterprise', enterprise);
app.route('/api/contact', contact);
app.route('/api/referral', referral);
app.route('/api/affiliate', affiliate);
app.route('/api/tenants', tenants);
app.route('/api/support', support);
app.route('/api/customer', customer);

// 404 fallback
app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

// Global error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err.message);
  return c.json({ error: 'Internal server error' }, 500);
});

export default app;
