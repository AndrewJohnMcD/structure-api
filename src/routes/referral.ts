import { Hono } from 'hono';
import { Env } from '../types';

const referral = new Hono<{ Bindings: Env }>();

const FP_BASE = 'https://firstpromoter.com/api/v1';

/**
 * POST /api/referral/validate
 * Validates a referral code against FirstPromoter.
 * Returns { valid: true, promoter_id, ref_id } if the code exists and is active.
 * Returns { valid: false } otherwise.
 */
referral.post('/validate', async (c) => {
  const body = await c.req.json<{ code: string }>();

  if (!body.code || body.code.trim().length === 0) {
    return c.json({ valid: false, error: 'No referral code provided' }, 400);
  }

  const code = body.code.trim();

  try {
    const res = await fetch(`${FP_BASE}/promoters/list?ref_id=${encodeURIComponent(code)}`, {
      headers: {
        'x-api-key': c.env.FIRSTPROMOTER_API_KEY,
        'Account-ID': c.env.FIRSTPROMOTER_ACCOUNT_ID,
      },
    });

    if (!res.ok) {
      console.error('FirstPromoter API error:', res.status, await res.text());
      return c.json({ valid: false, error: 'Unable to validate code at this time' }, 502);
    }

    const promoters = await res.json() as any[];

    const match = promoters.find(
      (p: any) => p.ref_id === code && p.state === 'active'
    );

    if (match) {
      return c.json({
        valid: true,
        promoter_id: match.id,
        ref_id: match.ref_id,
      });
    }

    return c.json({ valid: false });
  } catch (err: any) {
    console.error('Referral validation error:', err.message);
    return c.json({ valid: false, error: 'Validation service unavailable' }, 503);
  }
});

export { referral };
