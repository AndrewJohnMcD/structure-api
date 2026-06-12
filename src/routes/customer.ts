import { Hono } from 'hono';
import Stripe from 'stripe';
import { Env } from '../types';
import { customerAuth } from '../middleware';

const customer = new Hono<{ Bindings: Env }>();

// Apply customer authentication to all routes
customer.use('*', customerAuth);

// DigitalOcean API base URL
const DO_API = 'https://api.digitalocean.com/v2';

// Region mapping: friendly name -> DO slug
const REGIONS: Record<string, string> = {
  'Sydney, Australia': 'syd1',
  'Singapore': 'sgp1',
  'Bangalore, India': 'blr1',
  'Amsterdam, Netherlands': 'ams3',
  'Frankfurt, Germany': 'fra1',
  'London, United Kingdom': 'lon1',
  'New York, USA': 'nyc3',
  'San Francisco, USA': 'sfo3',
  'Toronto, Canada': 'tor1',
  'Atlanta, USA': 'atl1',
  'Richmond, USA': 'ric1',
};

// Reverse lookup: DO slug -> friendly name
const SLUG_TO_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(REGIONS).map(([name, slug]) => [slug, name])
);

// Set of valid slugs for direct validation
const VALID_SLUGS = new Set(Object.values(REGIONS));

/**
 * Helper: resolve region input to a valid DO slug.
 * Accepts both friendly names ("Sydney, Australia") and slugs ("syd1").
 */
function resolveRegion(input: string): { slug: string; name: string } | null {
  // Check if input is a valid slug directly
  if (VALID_SLUGS.has(input)) {
    return { slug: input, name: SLUG_TO_NAME[input] || input };
  }
  // Check if input is a friendly name
  const slug = REGIONS[input];
  if (slug) {
    return { slug, name: input };
  }
  return null;
}

/**
 * Helper: find Stripe customer by email.
 * Returns the first matching customer or null.
 */
async function findCustomerByEmail(
  stripe: Stripe,
  email: string
): Promise<Stripe.Customer | null> {
  const customers = await stripe.customers.list({ email, limit: 1 });
  if (customers.data.length === 0) return null;
  return customers.data[0];
}

/**
 * GET /api/customer/status
 *
 * Returns the authenticated customer\'s subscription and provisioning status.
 * Uses the email from the Clerk JWT to look up the Stripe Customer object,
 * which serves as the single source of truth for all account state.
 *
 * Response shape:
 *   - found: boolean
 *   - status: "no_subscription" | "awaiting_region" | "provisioning" | "active"
 *   - subscription: { id, status, currentPeriodEnd } | null
 *   - provisioning: { region, regionName, dropletId, dropletIp, status } | null
 *   - customerId: string | null
 */
customer.get('/status', async (c) => {
  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);
  const payload = c.get('jwtPayload') as Record<string, unknown> | undefined;

  // Extract email from JWT claims.
  // Clerk JWTs may include email at the top level or nested in metadata.
  const email = (payload?.email as string) ||
    (payload?.email_address as string) ||
    '';

  if (!email) {
    console.warn('Customer status: no email found in JWT payload');
    return c.json({
      found: false,
      status: 'no_subscription',
      subscription: null,
      provisioning: null,
      customerId: null,
    });
  }

  try {
    const stripeCustomer = await findCustomerByEmail(stripe, email);

    if (!stripeCustomer) {
      return c.json({
        found: false,
        status: 'no_subscription',
        subscription: null,
        provisioning: null,
        customerId: null,
      });
    }

    // Read metadata written by the webhook handler
    const meta = stripeCustomer.metadata || {};
    const provisioningStatus = meta.provisioningStatus || 'unknown';
    const region = meta.region || null;
    const regionName = region ? (SLUG_TO_NAME[region] || region) : null;
    const dropletId = meta.dropletId || null;
    const dropletIp = meta.dropletIp || null;

    // Fetch active subscription
    const subscriptions = await stripe.subscriptions.list({
      customer: stripeCustomer.id,
      status: 'active',
      limit: 1,
    });

    const activeSub = subscriptions.data[0] || null;

    // Determine overall status
    let status = 'no_subscription';
    if (activeSub) {
      if (provisioningStatus === 'active' && dropletId) {
        status = 'active';
      } else if (provisioningStatus === 'provisioning') {
        status = 'provisioning';
      } else if (region) {
        status = 'provisioning';
      } else {
        status = 'awaiting_region';
      }
    }

    return c.json({
      found: true,
      status,
      subscription: activeSub
        ? {
            id: activeSub.id,
            status: activeSub.status,
            currentPeriodEnd: new Date(
              activeSub.current_period_end * 1000
            ).toISOString(),
          }
        : null,
      provisioning:
        provisioningStatus !== 'unknown'
          ? {
              status: provisioningStatus,
              region,
              regionName,
              dropletId,
              dropletIp,
            }
          : null,
      customerId: stripeCustomer.id,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Customer status error:', message);
    return c.json({ error: 'Failed to retrieve customer status' }, 500);
  }
});

/**
 * GET /api/customer/regions
 * Returns the list of available provisioning regions.
 * Identical to the admin endpoint but accessible to authenticated customers.
 */
customer.get('/regions', (c) => {
  const regions = Object.entries(REGIONS).map(([name, slug]) => ({
    name,
    slug,
  }));
  return c.json({ regions });
});

/**
 * POST /api/customer/region
 *
 * Accepts the customer\'s region selection, writes it to Stripe metadata,
 * and triggers DigitalOcean Droplet provisioning.
 *
 * Request body: { region: string }
 * Region can be a friendly name or DO slug.
 *
 * This endpoint:
 *   1. Validates the customer has an active subscription
 *   2. Validates the region
 *   3. Checks they haven\'t already been provisioned
 *   4. Writes region + provisioning status to Stripe metadata
 *   5. Provisions a DigitalOcean Droplet
 *   6. Writes Droplet details back to Stripe metadata
 */
customer.post('/region', async (c) => {
  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);
  const payload = c.get('jwtPayload') as Record<string, unknown> | undefined;

  const email = (payload?.email as string) ||
    (payload?.email_address as string) ||
    '';

  if (!email) {
    return c.json({ error: 'Unable to identify customer' }, 400);
  }

  const body = await c.req.json<{ region: string }>();

  if (!body.region) {
    return c.json({ error: 'Missing required field: region' }, 400);
  }

  // Validate region
  const resolved = resolveRegion(body.region);
  if (!resolved) {
    return c.json(
      {
        error: 'Invalid region',
        validRegions: Object.entries(REGIONS).map(([name, slug]) => ({
          name,
          slug,
        })),
      },
      400
    );
  }

  try {
    // Find the Stripe customer
    const stripeCustomer = await findCustomerByEmail(stripe, email);
    if (!stripeCustomer) {
      return c.json({ error: 'No subscription found for this account' }, 404);
    }

    // Verify active subscription exists
    const subscriptions = await stripe.subscriptions.list({
      customer: stripeCustomer.id,
      status: 'active',
      limit: 1,
    });

    if (subscriptions.data.length === 0) {
      return c.json({ error: 'No active subscription found' }, 403);
    }

    // Check if already provisioned
    const meta = stripeCustomer.metadata || {};
    if (meta.dropletId && meta.provisioningStatus === 'active') {
      return c.json(
        {
          error: 'Instance already provisioned',
          provisioning: {
            status: meta.provisioningStatus,
            region: meta.region,
            regionName: SLUG_TO_NAME[meta.region] || meta.region,
            dropletId: meta.dropletId,
            dropletIp: meta.dropletIp,
          },
        },
        409
      );
    }

    // Update Stripe metadata: mark as provisioning
    await stripe.customers.update(stripeCustomer.id, {
      metadata: {
        ...meta,
        region: resolved.slug,
        provisioningStatus: 'provisioning',
      },
    });

    console.log(
      `PROVISIONING: customer=${stripeCustomer.id}, ` +
        `email=${email}, region=${resolved.slug} (${resolved.name})`
    );

    // Provision DigitalOcean Droplet
    const dropletName = `structure-${stripeCustomer.id
      .replace('cus_', '')
      .toLowerCase()
      .slice(0, 20)}`;

    const doResponse = await fetch(`${DO_API}/droplets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${c.env.DO_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: dropletName,
        region: resolved.slug,
        size: 's-4vcpu-8gb-amd',
        image: 'ubuntu-24-04-x64',
        tags: ['structure', 'customer', stripeCustomer.id],
      }),
    });

    if (!doResponse.ok) {
      const doError = await doResponse.text();
      console.error(`DigitalOcean provisioning failed: ${doError}`);

      // Revert metadata to awaiting state
      await stripe.customers.update(stripeCustomer.id, {
        metadata: {
          ...meta,
          region: resolved.slug,
          provisioningStatus: 'provisioning_failed',
        },
      });

      return c.json({ error: 'Failed to provision instance' }, 502);
    }

    const doData = (await doResponse.json()) as {
      droplet: { id: number; networks?: { v4?: Array<{ ip_address: string; type: string }> } };
    };

    const dropletId = String(doData.droplet.id);
    const publicNetwork = doData.droplet.networks?.v4?.find(
      (n) => n.type === 'public'
    );
    const dropletIp = publicNetwork?.ip_address || 'pending';

    // Write Droplet details back to Stripe metadata
    await stripe.customers.update(stripeCustomer.id, {
      metadata: {
        ...meta,
        region: resolved.slug,
        provisioningStatus: 'active',
        dropletId,
        dropletIp,
        dropletName,
        provisionedAt: new Date().toISOString(),
      },
    });

    console.log(
      `PROVISIONED: customer=${stripeCustomer.id}, ` +
        `droplet=${dropletId}, ip=${dropletIp}, region=${resolved.slug}`
    );

    return c.json({
      success: true,
      provisioning: {
        status: 'active',
        region: resolved.slug,
        regionName: resolved.name,
        dropletId,
        dropletIp,
        dropletName,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Region selection error:', message);
    return c.json({ error: 'Failed to process region selection' }, 500);
  }
});

export { customer };
