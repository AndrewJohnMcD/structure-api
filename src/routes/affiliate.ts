import { Hono } from 'hono';
import { Env } from '../types';

const affiliate = new Hono<{ Bindings: Env }>();

// Helper: fetch promoter by email from FirstPromoter
async function getPromoterByEmail(email: string, apiKey: string) {
  const res = await fetch(
    `https://firstpromoter.com/api/v1/promoters/list?email=${encodeURIComponent(email)}`,
    {
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
    }
  );

  if (!res.ok) {
    throw new Error(`FirstPromoter API returned ${res.status}`);
  }

  const promoters = await res.json() as Array<Record<string, unknown>>;

  if (!promoters || promoters.length === 0) {
    return null;
  }

  return promoters[0];
}

/**
 * GET /api/affiliate/stats?email=...
 * Returns promoter overview: ref_id, state, referral_link, stats, tier info.
 */
affiliate.get('/stats', async (c) => {
  const email = c.req.query('email');

  if (!email) {
    return c.json({ error: 'Email parameter is required' }, 400);
  }

  try {
    const promoter = await getPromoterByEmail(email, c.env.FIRSTPROMOTER_API_KEY);

    if (!promoter) {
      return c.json({ error: 'No affiliate account found for this email' }, 404);
    }

    const p = promoter as Record<string, unknown>;

    return c.json({
      id: p.id,
      ref_id: p.ref_id,
      state: p.state,
      referral_link: p.default_ref_link || `https://quantum.optimisingperformance.com.au?ref=${p.ref_id}`,
      stats: {
        referrals_count: p.customers_count || 0,
        active_referrals: p.active_customers_count || 0,
        current_balance: p.current_balance || 0,
        paid_balance: p.paid_balance || 0,
        total_revenue: p.total_revenue || 0,
      },
      tier: {
        direct_commission: '40%',
        sub_affiliate_commission: '4%',
      },
    });
  } catch (err) {
    console.error('Affiliate stats error:', err);
    return c.json({ error: 'Failed to retrieve affiliate data' }, 500);
  }
});

/**
 * GET /api/affiliate/referrals?email=...
 * Returns list of referred customers for this promoter.
 */
affiliate.get('/referrals', async (c) => {
  const email = c.req.query('email');

  if (!email) {
    return c.json({ error: 'Email parameter is required' }, 400);
  }

  try {
    const promoter = await getPromoterByEmail(email, c.env.FIRSTPROMOTER_API_KEY);

    if (!promoter) {
      return c.json({ error: 'No affiliate account found for this email' }, 404);
    }

    const promoterId = (promoter as Record<string, unknown>).id;

    // Fetch referrals (leads) for this promoter
    const leadsRes = await fetch(
      `https://firstpromoter.com/api/v1/leads/list?promoter_id=${promoterId}`,
      {
        headers: {
          'x-api-key': c.env.FIRSTPROMOTER_API_KEY,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!leadsRes.ok) {
      throw new Error(`Leads API returned ${leadsRes.status}`);
    }

    const leads = await leadsRes.json() as Array<Record<string, unknown>>;

    const referrals = leads.map((lead) => ({
      id: lead.id,
      customer_id: lead.uid || `CUST-${lead.id}`,
      state: lead.state || 'active',
      plan: lead.plan_name || 'Standard ($540/mo)',
      created_at: lead.created_at,
      commission_amount: lead.commission_amount || 0,
    }));

    return c.json({
      promoter_id: promoterId,
      referrals,
    });
  } catch (err) {
    console.error('Affiliate referrals error:', err);
    return c.json({ error: 'Failed to retrieve referral data' }, 500);
  }
});

/**
 * GET /api/affiliate/earnings?email=...
 * Returns balance summary and recent commission transactions.
 */
affiliate.get('/earnings', async (c) => {
  const email = c.req.query('email');

  if (!email) {
    return c.json({ error: 'Email parameter is required' }, 400);
  }

  try {
    const promoter = await getPromoterByEmail(email, c.env.FIRSTPROMOTER_API_KEY);

    if (!promoter) {
      return c.json({ error: 'No affiliate account found for this email' }, 404);
    }

    const p = promoter as Record<string, unknown>;
    const promoterId = p.id;

    // Fetch commission transactions
    const commissionsRes = await fetch(
      `https://firstpromoter.com/api/v1/rewards/list?promoter_id=${promoterId}`,
      {
        headers: {
          'x-api-key': c.env.FIRSTPROMOTER_API_KEY,
          'Content-Type': 'application/json',
        },
      }
    );

    let transactions: Array<Record<string, unknown>> = [];

    if (commissionsRes.ok) {
      const rewards = await commissionsRes.json() as Array<Record<string, unknown>>;
      transactions = rewards.map((r) => ({
        id: r.id,
        amount: r.amount || 0,
        status: r.status || 'pending',
        type: r.kind || 'commission',
        customer: r.lead_email || r.lead_uid || 'Unknown',
        created_at: r.created_at,
      }));
    }

    return c.json({
      promoter_id: promoterId,
      current_balance: p.current_balance || 0,
      paid_balance: p.paid_balance || 0,
      transactions,
    });
  } catch (err) {
    console.error('Affiliate earnings error:', err);
    return c.json({ error: 'Failed to retrieve earnings data' }, 500);
  }
});

export { affiliate };
