import { Hono } from 'hono';
import Stripe from 'stripe';
import { Env } from '../types';

const billing = new Hono<{ Bindings: Env }>();

/**
 * POST /api/billing-portal
 * Creates a Stripe Customer Portal session for managing subscriptions.
 * Requires the Clerk-authenticated customer's Stripe customer ID.
 */
billing.post('/', async (c) => {
  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);

  const body = await c.req.json<{
    customerId: string;
    returnUrl: string;
  }>();

  if (!body.customerId || !body.returnUrl) {
    return c.json({ error: 'Missing required fields: customerId, returnUrl' }, 400);
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: body.customerId,
      return_url: body.returnUrl,
    });
    return c.json({ url: session.url });
  } catch (err: any) {
    console.error('Stripe billing portal error:', err.message);
    return c.json({ error: 'Failed to create billing portal session' }, 500);
  }
});

export { billing };
