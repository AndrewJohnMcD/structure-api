import { Hono } from 'hono';
import { Env } from '../types';

const affiliate = new Hono<{ Bindings: Env }>();

const FP_BASE = 'https://firstpromoter.com/api/v1';

function fpHeaders(env: Env) {
  return {
    'x-api-key': env.FIRSTPROMOTER_API_KEY,
    'Account-ID': env.FIRSTPROMOTER_ACCOUNT_ID,
  };
}

/**
 * GET /api/affiliate/stats?email={email}
 * Returns the promoter's dashboard stats from FirstPromoter.
 */
affiliate.get('/stats', async (c) => {
  const email = c.req.query('email');

  if (!email) {
    return c.json({ error: 'Missing required query parameter: email' }, 400);
  }

  try {
    const res = await fetch(
      `${FP_BASE}/promoters/show?email=${encodeURIComponent(email)}`,
      { headers: fpHeaders(c.env) }
    );

    if (!res.ok) {
      if (res.status === 404) {
        return c.json({ error: 'Promoter not found' }, 404);
      }
      console.error('FirstPromoter stats error:', res.status);
      return c.json({ error: 'Unable to fetch stats' }, 502);
    }

    const promoter = await res.json() as any;

    return c.json({
      id: promoter.id,
      ref_id: promoter.ref_id,
      state: promoter.state,
      referral_link: promoter.default_ref_link,
      stats: {
        referrals_count: promoter.referrals_count || 0,
        active_referrals: promoter.customers_count || 0,
        current_balance: promoter.current_balance || 0,
        paid_balance: promoter.paid_balance || 0,
        total_revenue: promoter.total_revenue || 0,
      },
      tier: {
        direct_commission: '40%',
        sub_affiliate_commission: '4%',
      },
    });
  } catch (err: any) {
    console.error('Affiliate stats error:', err.message);
    return c.json({ error: 'Stats service unavailable' }, 503);
  }
});

/**
 * GET /api/affiliate/referrals?email={email}
 * Returns the list of referrals for a given promoter.
 */
affiliate.get('/referrals', async (c) => {
  const email = c.req.query('email');

  if (!email) {
    return c.json({ error: 'Missing required query parameter: email' }, 400);
  }

  try {
    const promoterRes = await fetch(
      `${FP_BASE}/promoters/show?email=${encodeURIComponent(email)}`,
      { headers: fpHeaders(c.env) }
    );

    if (!promoterRes.ok) {
      if (promoterRes.status === 404) {
        return c.json({ error: 'Promoter not found' }, 404);
      }
      return c.json({ error: 'Unable to fetch promoter' }, 502);
    }

    const promoter = await promoterRes.json() as any;

    const refRes = await fetch(
      `${FP_BASE}/referrals/list?promoter_id=${promoter.id}`,
      { headers: fpHeaders(c.env) }
    );

    if (!refRes.ok) {
      console.error('FirstPromoter referrals error:', refRes.status);
      return c.json({ error: 'Unable to fetch referrals' }, 502);
    }

    const referrals = await refRes.json() as any[];

    return c.json({
      promoter_id: promoter.id,
      referrals: referrals.map((ref: any) => ({
        id: ref.id,
        customer_id: ref.uid || ref.customer_id,
        state: ref.state,
        plan: ref.plan_name || 'Standard',
        created_at: ref.created_at,
        commission_amount: ref.commission_amount || 0,
      })),
    });
  } catch (err: any) {
    console.error('Affiliate referrals error:', err.message);
    return c.json({ error: 'Referrals service unavailable' }, 503);
  }
});

/**
 * GET /api/affiliate/earnings?email={email}
 * Returns commission transactions for a given promoter.
 */
affiliate.get('/earnings', async (c) => {
  const email = c.req.query('email');

  if (!email) {
    return c.json({ error: 'Missing required query parameter: email' }, 400);
  }

  try {
    const promoterRes = await fetch(
      `${FP_BASE}/promoters/show?email=${encodeURIComponent(email)}`,
      { headers: fpHeaders(c.env) }
    );

    if (!promoterRes.ok) {
      if (promoterRes.status === 404) {
        return c.json({ error: 'Promoter not found' }, 404);
      }
      return c.json({ error: 'Unable to fetch promoter' }, 502);
    }

    const promoter = await promoterRes.json() as any;

    const rewardsRes = await fetch(
      `${FP_BASE}/rewards/list?promoter_id=${promoter.id}`,
      { headers: fpHeaders(c.env) }
    );

    if (!rewardsRes.ok) {
      console.error('FirstPromoter rewards error:', rewardsRes.status);
      return c.json({ error: 'Unable to fetch earnings' }, 502);
    }

    const rewards = await rewardsRes.json() as any[];

    return c.json({
      promoter_id: promoter.id,
      current_balance: promoter.current_balance || 0,
      paid_balance: promoter.paid_balance || 0,
      transactions: rewards.map((r: any) => ({
        id: r.id,
        amount: r.amount || 0,
        status: r.status,
        type: r.tier === 2 ? 'Tier 2 (4%)' : 'Tier 1 (40%)',
        customer: r.referral?.uid || 'Unknown',
        created_at: r.created_at,
      })),
    });
  } catch (err: any) {
    console.error('Affiliate earnings error:', err.message);
    return c.json({ error: 'Earnings service unavailable' }, 503);
  }
});

export { affiliate };
