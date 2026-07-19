import { Hono } from 'hono';
import Stripe from 'stripe';
import { Env } from '../types';

const checkout = new Hono<{ Bindings: Env }>();

// ============================================================
// ACCESS CODE TIERS
// ============================================================
// Beta:       Hardcoded secret. 99% discount. No FirstPromoter.
// First Wave: Hardcoded "inception". ~82% discount ($441 off).
//             Attribution flows to Seed Promoter.
// Universal:  Hardcoded "universal". 40% discount ($324/mo).
//             Company-direct. No affiliate attribution.
// Partner:    Any other code. 40% discount.
//             Attribution flows to referring promoter.
// ============================================================

const BETA_CODE = 'DONTEVENTRYITbba71uy6sCimxugXqYmGPmVp8mNktNz5x54c8kuBejv4UFi6r9d';
const FIRSTWAVE_CODE = 'inception';
const UNIVERSAL_CODE = 'universal';
const PREVIEW_CODE = 'jan-free';

/**
 * Determines the coupon tier for a given access code.
 * Returns the coupon env key and whether FirstPromoter attribution applies.
 */
function resolveAccessTier(code: string): {
  couponKey: 'STRIPE_COUPON_BETA' | 'STRIPE_COUPON_FIRSTWAVE' | 'STRIPE_COUPON_PREVIEW' | 'STRIPE_COUPON_ID';
  attributeToPromoter: boolean;
} {
  if (code === BETA_CODE) {
    return { couponKey: 'STRIPE_COUPON_BETA', attributeToPromoter: false };
  }
  if (code.toLowerCase() === FIRSTWAVE_CODE) {
    return { couponKey: 'STRIPE_COUPON_FIRSTWAVE', attributeToPromoter: true };
  }
  if (code.toLowerCase() === UNIVERSAL_CODE) {
    return { couponKey: 'STRIPE_COUPON_ID', attributeToPromoter: false };
  }
if (code.toLowerCase() === PREVIEW_CODE) {
return { couponKey: 'STRIPE_COUPON_PREVIEW', attributeToPromoter: false };
}
  return { couponKey: 'STRIPE_COUPON_ID', attributeToPromoter: true };
}

/**
 * POST /api/checkout
 * Creates a Stripe Checkout Session with tiered discount logic.
 * Access codes route to Beta, First Wave, or Partner coupon tiers.
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

  // Accept both camelCase and snake_case for access code
  const accessCode = body.referralCode || body.referral_code;

  const metadata: Record<string, string> = {};
  if (body.region) {
    metadata.region = body.region;
  }
  if (accessCode) {
    metadata.referralCode = accessCode;
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
  };

  // Apply tiered discount and attribution logic
  if (accessCode && accessCode.trim().length > 0) {
    const tier = resolveAccessTier(accessCode.trim());
    const couponId = c.env[tier.couponKey];

    if (couponId) {
      sessionParams.discounts = [
        {
          coupon: couponId,
        },
      ];
    }

    // FirstPromoter revenue attribution: bridges Stripe payment to promoter
    // Beta tier is excluded -- no affiliate attribution for internal testing
    if (tier.attributeToPromoter) {
      sessionParams.client_reference_id = accessCode.trim();
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
