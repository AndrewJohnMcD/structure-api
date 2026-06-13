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

function resolveRegion(input: string): { slug: string; name: string } | null {
  if (VALID_SLUGS.has(input)) {
    return { slug: input, name: SLUG_TO_NAME[input] || input };
  }
  const slug = REGIONS[input];
  if (slug) {
    return { slug, name: input };
  }
  return null;
}

// ============================================================
// Clerk Cache-Through Helpers
// ============================================================

async function getCachedStripeId(
  clerkUserId: string,
  clerkSecretKey: string
): Promise<string | null> {
  try {
    const res = await fetch(`https://api.clerk.com/v1/users/${clerkUserId}`, {
      headers: { Authorization: `Bearer ${clerkSecretKey}` },
    });
    if (!res.ok) {
      console.warn(`Clerk user fetch failed: ${res.status}`);
      return null;
    }
    const user = (await res.json()) as {
      private_metadata?: { stripeCustomerId?: string };
    };
    return user.private_metadata?.stripeCustomerId || null;
  } catch (err) {
    console.warn('Clerk cache read failed:', err);
    return null;
  }
}

async function cacheStripeId(
  clerkUserId: string,
  stripeCustomerId: string,
  clerkSecretKey: string
): Promise<void> {
  try {
    const res = await fetch(`https://api.clerk.com/v1/users/${clerkUserId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${clerkSecretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        private_metadata: { stripeCustomerId },
      }),
    });
    if (res.ok) {
      console.log(`Cached stripeCustomerId=${stripeCustomerId} for Clerk user ${clerkUserId}`);
    } else {
      console.warn(`Clerk cache write failed: ${res.status}`);
    }
  } catch (err) {
    console.warn('Clerk cache write error:', err);
  }
}

async function resolveStripeCustomer(
  stripe: Stripe,
  clerkUserId: string,
  email: string,
  clerkSecretKey: string
): Promise<Stripe.Customer | null> {
  // --- Fast path: check cache ---
  const cachedId = await getCachedStripeId(clerkUserId, clerkSecretKey);

  if (cachedId) {
    try {
      const cust = await stripe.customers.retrieve(cachedId);
      if (cust && !(cust as Stripe.DeletedCustomer).deleted) {
        console.log(`Cache HIT: Clerk=${clerkUserId} -> Stripe=${cachedId}`);
        return cust as Stripe.Customer;
      }
    } catch {
      console.warn(`Cached Stripe ID ${cachedId} invalid, falling through to email search`);
    }
  }

  // --- Slow path: search by email ---
  if (!email) return null;

  const customers = await stripe.customers.list({ email, limit: 1 });
  if (customers.data.length === 0) {
    console.log(`Cache MISS: no Stripe customer found for email=${email}`);
    return null;
  }

  const found = customers.data[0];
  console.log(`Cache MISS: Clerk=${clerkUserId} -> Stripe=${found.id} (caching now)`);

  // --- Write-through: cache for next time ---
  await cacheStripeId(clerkUserId, found.id, clerkSecretKey);

  return found;
}

function extractIdentity(payload: Record<string, unknown>): {
  clerkUserId: string;
  email: string;
} {
  const clerkUserId = (payload.sub as string) || '';
  const email =
    (payload.email as string) ||
    (payload.email_address as string) ||
    '';
  return { clerkUserId, email };
}

// ============================================================
// Routes
// ============================================================

customer.get('/status', async (c) => {
  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);
  const payload = c.get('jwtPayload') as Record<string, unknown> | undefined;

  const emptyResponse = {
    customerId: null,
    email: '',
    subscriptionStatus: 'none',
    provisioningStatus: 'none',
    region: null,
    regionName: null,
    dropletId: null,
    dropletIp: null,
  };

  if (!payload) {
    return c.json(emptyResponse);
  }

  const { clerkUserId, email } = extractIdentity(payload);

  if (!email && !clerkUserId) {
    console.warn('Customer status: no identity found in JWT payload');
    return c.json(emptyResponse);
  }

  try {
    const stripeCustomer = await resolveStripeCustomer(
      stripe, clerkUserId, email, c.env.CLERK_SECRET_KEY
    );

    if (!stripeCustomer) {
      return c.json({ ...emptyResponse, email });
    }

    const meta = stripeCustomer.metadata || {};
    const region = meta.region || null;
    const regionName = region ? (SLUG_TO_NAME[region] || region) : null;
    const dropletId = meta.dropletId || null;
    const dropletIp = meta.dropletIp || null;
    const rawProvStatus = meta.provisioningStatus || '';

    const subscriptions = await stripe.subscriptions.list({
      customer: stripeCustomer.id,
      status: 'active',
      limit: 1,
    });

    const activeSub = subscriptions.data[0] || null;
    const subscriptionStatus = activeSub ? activeSub.status : 'none';

    let provisioningStatus = 'none';
    if (activeSub) {
      if (rawProvStatus === 'active' && dropletId) {
        provisioningStatus = 'provisioned';
      } else if (rawProvStatus === 'provisioning') {
        provisioningStatus = 'provisioning';
      } else if (rawProvStatus === 'provisioning_failed') {
        provisioningStatus = 'provisioning_failed';
      } else if (rawProvStatus === 'awaiting_region_selection' || !region) {
        provisioningStatus = 'awaiting_region';
      } else {
        provisioningStatus = 'awaiting_region';
      }
    }

    return c.json({
      customerId: stripeCustomer.id,
      email,
      subscriptionStatus,
      provisioningStatus,
      region,
      regionName,
      dropletId,
      dropletIp,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Customer status error:', message);
    return c.json({ error: 'Failed to retrieve customer status' }, 500);
  }
});

customer.get('/regions', (c) => {
  const regions = Object.entries(REGIONS).map(([name, slug]) => ({
    name,
    slug,
  }));
  return c.json({ regions });
});

customer.post('/region', async (c) => {
  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);
  const payload = c.get('jwtPayload') as Record<string, unknown> | undefined;

  if (!payload) {
    return c.json({ error: 'Unable to identify customer' }, 400);
  }

  const { clerkUserId, email } = extractIdentity(payload);

  if (!email && !clerkUserId) {
    return c.json({ error: 'Unable to identify customer' }, 400);
  }

  const body = await c.req.json<{ region: string }>();

  if (!body.region) {
    return c.json({ error: 'Missing required field: region' }, 400);
  }

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
    const stripeCustomer = await resolveStripeCustomer(
      stripe, clerkUserId, email, c.env.CLERK_SECRET_KEY
    );

    if (!stripeCustomer) {
      return c.json({ error: 'No subscription found for this account' }, 404);
    }

    const subscriptions = await stripe.subscriptions.list({
      customer: stripeCustomer.id,
      status: 'active',
      limit: 1,
    });

    if (subscriptions.data.length === 0) {
      return c.json({ error: 'No active subscription found' }, 403);
    }

    const meta = stripeCustomer.metadata || {};
    if (meta.dropletId && meta.provisioningStatus === 'active') {
      return c.json(
        {
          error: 'Instance already provisioned',
          provisioning: {
            status: 'provisioned',
            region: meta.region,
            regionName: SLUG_TO_NAME[meta.region] || meta.region,
            dropletId: meta.dropletId,
            dropletIp: meta.dropletIp,
          },
        },
        409
      );
    }

    // Mark as provisioning
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

    // Create DigitalOcean Droplet
    const dropletName = `structure-${stripeCustomer.id.replace('cus_', '').toLowerCase()}`;
    const doRes = await fetch(`${DO_API}/droplets`, {
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
        tags: ['structure', 'customer'],
      }),
    });

    if (!doRes.ok) {
      const errBody = await doRes.text();
      console.error(`DO provisioning failed: ${doRes.status} ${errBody}`);
      await stripe.customers.update(stripeCustomer.id, {
        metadata: {
          ...meta,
          region: resolved.slug,
          provisioningStatus: 'provisioning_failed',
        },
      });
      return c.json({ error: 'Provisioning failed' }, 502);
    }

    const doData = (await doRes.json()) as {
      droplet: { id: number; networks?: { v4?: Array<{ ip_address: string; type: string }> } };
    };
    const droplet = doData.droplet;
    const publicNet = droplet.networks?.v4?.find((n) => n.type === 'public');
    const dropletIp = publicNet?.ip_address || 'pending';

    // Update Stripe metadata with provisioning result
    await stripe.customers.update(stripeCustomer.id, {
      metadata: {
        ...meta,
        region: resolved.slug,
        provisioningStatus: 'active',
        dropletId: String(droplet.id),
        dropletIp,
      },
    });

    console.log(
      `PROVISIONED: customer=${stripeCustomer.id}, ` +
        `droplet=${droplet.id}, ip=${dropletIp}, region=${resolved.slug}`
    );

    // Send welcome email via Resend
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${c.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'The Structure <noreply@mail.optimisingperformance.com.au>',
          to: [email],
          subject: 'Your Structure Instance is Ready',
          html: `<h2>Welcome to The Structure</h2>
            <p>Your instance has been provisioned successfully.</p>
            <ul>
              <li><strong>Region:</strong> ${resolved.name}</li>
              <li><strong>IP Address:</strong> ${dropletIp}</li>
            </ul>
            <p>Access your dashboard at <a href="https://portal.optimisingperformance.com.au">portal.optimisingperformance.com.au</a></p>
            <p>-- The Structure Team</p>`,
        }),
      });
      console.log(`Welcome email sent to ${email}`);
    } catch (emailErr) {
      console.warn('Welcome email failed (non-blocking):', emailErr);
    }

    return c.json({
      status: 'provisioned',
      region: resolved.slug,
      regionName: resolved.name,
      dropletId: String(droplet.id),
      dropletIp,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Region selection error:', message);
    return c.json({ error: 'Failed to process region selection' }, 500);
  }
});

export { customer };
