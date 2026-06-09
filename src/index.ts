import { Hono } from 'hono';
import { Env } from './types';
import { corsMiddleware } from './middleware';
import { checkout } from './routes/checkout';
import { billing } from './routes/billing';
import { enterprise } from './routes/enterprise';
import { referral } from './routes/referral';
import { affiliate } from './routes/affiliate';
import { tenants } from './routes/tenants';
import { support } from './routes/support';

const app = new Hono<{ Bindings: Env }>();

// Apply CORS to all routes
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
app.route('/api/referral', referral);
app.route('/api/affiliate', affiliate);
app.route('/api/tenants', tenants);
app.route('/api/support', support);

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
