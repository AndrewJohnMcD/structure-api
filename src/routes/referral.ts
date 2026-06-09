import { Hono } from 'hono';
import { Env } from '../types';

const referral = new Hono<{ Bindings: Env }>();

/**
 * Valid promoter states that should be treated as eligible for referral codes.
 * FirstPromoter uses different state strings depending on approval workflow:
 * - 'active': fully active promoter
 * - 'accepted': promoter accepted into campaign (default for new signups)
 * - 'approved': alternative approval state
 */
const VALID_PROMOTER_STATES = new Set(['active', 'accepted', 'approved']);

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

    // Log raw response for diagnostic visibility
    console.log('FirstPromoter lookup:', JSON.stringify({
      code,
      results: promoters.length,
      promoters: promoters.map((p) => ({ id: p.id, ref_id: p.ref_id, state: p.state })),
    }));

    // Find a promoter matching the code with a valid state
    const match = promoters.find(
      (p) => p.ref_id === code && VALID_PROMOTER_STATES.has(p.state)
    );

    if (match) {
      return c.json({ valid: true, ref_id: match.ref_id });
    }

    // If promoters were found but none matched state requirements, log the mismatch
    const codeMatch = promoters.find((p) => p.ref_id === code);
    if (codeMatch) {
      console.warn(
        `Referral code "${code}" found but promoter state "${codeMatch.state}" is not in valid set:`,
        Array.from(VALID_PROMOTER_STATES)
      );
    }

    return c.json({ valid: false, error: 'Invalid or inactive referral code' });
  } catch (err) {
    console.error('Referral validation error:', err);
    return c.json({ valid: false, error: 'Validation service unavailable' }, 500);
  }
});

export { referral };
