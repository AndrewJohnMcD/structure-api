import { Hono } from 'hono';
import Stripe from 'stripe';
import { Env } from '../types';

const checkout = new Hono<{ Bindings: Env }>();

/**
 * POST /api/checkout
 * Creates a Stripe Checkout Session for the Standard Plan.
 * If a valid referral code is provided, applies the 40% partner coupon.
 * Region is optional -- customers select their region post-purchase.
 */
checkout.post('/', async (c) => {
  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);

  const body = await c.req.json<{
    referralCode?: string;
    referral_code?: string;
    region?: string;
    successUrl: string;
    cancelUrl: string;
  }>();

  if (!body.successUrl || !body.cancelUrl) {
    return c.json({ error: 'Missing required fields: successUrl, cancelUrl' }, 400);
  }

  // Accept both camelCase and snake_case for referral code
  const referralCode = body.referralCode || body.referral_code;

  const metadata: Record<string, string> = {};
  if (body.region) {
    metadata.region = body.region;
  }
  if (referralCode) {
    metadata.referralCode = referralCode;
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
    metadata,
    subscription_data: {
      metadata,
    },
    // FirstPromoter revenue attribution: bridges Stripe payment to promoter
    // Immune to ad-blockers since this is server-to-server
    ...(referralCode ? { client_reference_id: referralCode } : {}),
  };

  // Apply partner coupon if referral code is provided
  if (referralCode && referralCode.trim().length > 0) {
    sessionParams.discounts = [
      {
        coupon: c.env.STRIPE_COUPON_ID,
      },
    ];
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
