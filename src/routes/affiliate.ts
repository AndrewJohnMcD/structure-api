import { Hono } from 'hono';
import { Env } from '../types';

const affiliate = new Hono<{ Bindings: Env }>();

// Helper: fetch promoter by email from FirstPromoter
// CRITICAL: Uses /promoters/show?promoter_email= (NOT /promoters/list?email=)
// The /promoters/list endpoint does NOT support email filtering -- it only
// supports campaign_id. Passing email= is silently ignored, returning ALL
// promoters sorted by creation date. This caused a bug where the most recently
// created promoter was displayed instead of the authenticated user's record.
async function getPromoterByEmail(email: string, apiKey: string, accountId: string) {
  const res = await fetch(
    `https://firstpromoter.com/api/v1/promoters/show?promoter_email=${encodeURIComponent(email)}`,
    {
      headers: {
        'x-api-key': apiKey,
        'x-account-id': accountId,
        'Content-Type': 'application/json',
      },
    }
  );

  // 404 means no promoter exists for this email -- valid response, not an error
  if (res.status === 404) {
    return null;
  }

  if (!res.ok) {
    throw new Error(`FirstPromoter API returned ${res.status}`);
  }

  // /promoters/show returns a single promoter object, not an array
  const promoter = await res.json() as Record<string, unknown>;
  return promoter;
}

/**
 * GET /api/affiliate/stats?email=...
 * Returns promoter overview: ref_id, status, referral_link, stats, tier info.
 *
 * FirstPromoter v1 API field mapping (documented in PR #12):
 *   - default_ref_id  (NOT ref_id)
 *   - status          (NOT state)
 *   - default_ref_link (referral URL)
 */
affiliate.get('/stats', async (c) => {
  const email = c.req.query('email');

  if (!email) {
    return c.json({ error: 'Email parameter is required' }, 400);
  }

  try {
    const promoter = await getPromoterByEmail(email, c.env.FIRSTPROMOTER_API_KEY, c.env.FIRSTPROMOTER_ACCOUNT_ID);

    if (!promoter) {
      return c.json({ error: 'No affiliate account found for this email' }, 404);
    }

    const p = promoter as Record<string, unknown>;

    // Diagnostic: log raw promoter structure for field name verification
    console.log('Raw promoter object keys:', Object.keys(p));
    console.log('Promoter identity:', { id: p.id, default_ref_id: p.default_ref_id, status: p.status });

    // Extract campaign stats from the promotions array
    // FirstPromoter nests referral/customer counts inside per-campaign objects,
    // NOT at the promoter top level. The top level only has balance fields.
    const promotions = Array.isArray(p.promotions) ? p.promotions as Array<Record<string, unknown>> : [];
    const campaign = promotions.length > 0 ? promotions[0] : {} as Record<string, unknown>;

    // Diagnostic: log campaign-level fields to verify exact field names
    console.log('Promotions array length:', promotions.length);
    if (promotions.length > 0) {
      console.log('Campaign[0] keys:', Object.keys(campaign));
      console.log('Campaign[0] stats:', {
        referrals_count: campaign.referrals_count,
        customers_count: campaign.customers_count,
        current_referral_revenue: campaign.current_referral_revenue,
        visitors_count: campaign.visitors_count,
      });
    }

    const refId = p.default_ref_id as string | undefined;

    return c.json({
      id: p.id,
      ref_id: refId || '',
      state: (p.status as string) || 'unknown',
      referral_link: (p.default_ref_link as string) || (refId ? `https://quantum.optimisingperformance.com.au?ref=${refId}` : ''),
      stats: {
        // Referral counts come from the campaign object, not promoter top level
        referrals_count: (campaign.referrals_count as number) || (campaign.customers_count as number) || 0,
        active_referrals: (campaign.customers_count as number) || 0,
        // Balance fields exist at the promoter top level
        current_balance: (p.current_balance as number) || 0,
        paid_balance: (p.paid_balance as number) || 0,
        // Total revenue: try campaign-level first, fall back to earnings_balance
        total_revenue: (campaign.current_referral_revenue as number) || (p.earnings_balance as number) || 0,
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
    const promoter = await getPromoterByEmail(email, c.env.FIRSTPROMOTER_API_KEY, c.env.FIRSTPROMOTER_ACCOUNT_ID);

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
          'x-account-id': c.env.FIRSTPROMOTER_ACCOUNT_ID,
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
    const promoter = await getPromoterByEmail(email, c.env.FIRSTPROMOTER_API_KEY, c.env.FIRSTPROMOTER_ACCOUNT_ID);

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
          'x-account-id': c.env.FIRSTPROMOTER_ACCOUNT_ID,
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
