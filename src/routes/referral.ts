import { Hono } from 'hono';
import { Env } from '../types';

const referral = new Hono<{ Bindings: Env }>();

/**
 * Valid promoter statuses that should be treated as eligible for referral codes.
 * FirstPromoter v1 API uses the "status" field (not "state") with values:
 * - 'active': fully active promoter
 * - 'approved': promoter approved into campaign
 * - 'accepted': alternative approval status
 */
const VALID_PROMOTER_STATUSES = new Set(['active', 'accepted', 'approved']);

/**
* Hardcoded access codes that bypass FirstPromoter validation.
* These are resolved to their respective discount tiers in checkout.ts.
* Beta: 99% discount for internal testing.
* First Wave: ~82% discount for influencer recruitment.
*/
const BETA_CODE = 'DONTEVENTRYITbba71uy6sCimxugXqYmGPmVp8mNktNz5x54c8kuBejv4UFi6r9d';
const FIRSTWAVE_CODE = 'inception';


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
  // Short-circuit: hardcoded codes bypass FirstPromoter entirely
  if (code === BETA_CODE) {
    return c.json({ valid: true, ref_id: code, tier: 'beta' });
  }
  if (code.toLowerCase() === FIRSTWAVE_CODE) {
    return c.json({ valid: true, ref_id: code, tier: 'firstwave' });
  }


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

    // FirstPromoter v1 API returns: default_ref_id (top-level) and status (not state)
    const promoters = await fpRes.json() as Array<{
      id: number;
      default_ref_id: string;
      status: string;
    }>;

    // Log raw response for diagnostic visibility
    console.log('FirstPromoter lookup:', JSON.stringify({
      code,
      results: promoters.length,
      promoters: promoters.map((p) => ({
        id: p.id,
        default_ref_id: p.default_ref_id,
        status: p.status,
      })),
    }));

    // Find a promoter matching the code with a valid status
    const match = promoters.find(
      (p) => p.default_ref_id === code && VALID_PROMOTER_STATUSES.has(p.status)
    );

    if (match) {
      return c.json({ valid: true, ref_id: match.default_ref_id, tier: 'partner' });
    }

    // If promoters were found but none matched status requirements, log the mismatch
    const codeMatch = promoters.find((p) => p.default_ref_id === code);
    if (codeMatch) {
      console.warn(
        `Referral code "${code}" found but promoter status "${codeMatch.status}" is not in valid set:`,
        Array.from(VALID_PROMOTER_STATUSES)
      );
    }

    return c.json({ valid: false, error: 'Invalid or inactive referral code' });
  } catch (err) {
    console.error('Referral validation error:', err);
    return c.json({ valid: false, error: 'Validation service unavailable' }, 500);
  }
});

export { referral };
