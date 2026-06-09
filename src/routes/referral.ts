import { Hono } from 'hono';
import { Env } from '../types';

const referral = new Hono<{ Bindings: Env }>();

/**
 * POST /api/referral/validate
 * Validates a referral code against FirstPromoter.
 * Returns { valid: boolean, ref_id: string } on success.
 */
referral.post('/validate', async (c) => {
  const body = await c.req.json<{ code: string }>();

  if (!body.code || typeof body.code !== 'string' || body.code.trim().length === 0) {
    return c.json({ valid: false, error: 'Referral code is required' }, 400);
  }

  const code = body.code.trim();

  try {
    // Look up promoter by ref_id in FirstPromoter
    const fpRes = await fetch(
      `https://firstpromoter.com/api/v1/promoters/list?ref_id=${encodeURIComponent(code)}`,
      {
        headers: {
          'x-api-key': c.env.FIRSTPROMOTER_API_KEY,
          'x-account-id': c.env.FIRSTPROMOTER_ACCOUNT_ID,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!fpRes.ok) {
      console.error('FirstPromoter API error:', fpRes.status);
      return c.json({ valid: false, error: 'Unable to validate code' }, 502);
    }

    const promoters = await fpRes.json() as Array<{ id: number; ref_id: string; state: string }>;

    // Find an active promoter matching the code
    const match = promoters.find(
      (p) => p.ref_id === code && p.state === 'active'
    );

    if (match) {
      return c.json({ valid: true, ref_id: match.ref_id });
    }

    return c.json({ valid: false, error: 'Invalid or inactive referral code' });
  } catch (err) {
    console.error('Referral validation error:', err);
    return c.json({ valid: false, error: 'Validation service unavailable' }, 500);
  }
});

export { referral };
