import { Hono } from 'hono';
import Stripe from 'stripe';
import { Env } from '../types';

const checkout = new Hono<{ Bindings: Env }>();

/**
 * POST /api/checkout
 * Creates a Stripe Checkout Session for the Standard Plan.
 * If a valid referral code is provided, applies the 40% partner coupon.
 */
checkout.post('/', async (c) => {
  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);

  const body = await c.req.json<{
    referralCode?: string;
    region: string;
    successUrl: string;
    cancelUrl: string;
  }>();

  if (!body.region || !body.successUrl || !body.cancelUrl) {
    return c.json({ error: 'Missing required fields: region, successUrl, cancelUrl' }, 400);
  }

  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [
      {
        price: c.env.STRIPE_PRICE_ID,
        quantity: 1,
      },
    ],
    success_url: body.successUrl,
    cancel_url: body.cancelUrl,
    metadata: {
      region: body.region,
    },
    subscription_data: {
      metadata: {
        region: body.region,
      },
    },
  };

  // Apply partner coupon if referral code is provided
  if (body.referralCode && body.referralCode.trim().length > 0) {
    sessionParams.discounts = [
      {
        coupon: c.env.STRIPE_COUPON_ID,
      },
    ];
    if (sessionParams.metadata) {
      sessionParams.metadata.referralCode = body.referralCode;
    }
  }

  try {
    const session = await stripe.checkout.sessions.create(sessionParams);
    return c.json({ url: session.url });
  } catch (err: any) {
    console.error('Stripe checkout error:', err.message);
    return c.json({ error: 'Failed to create checkout session' }, 500);
  }
});

export { checkout };
