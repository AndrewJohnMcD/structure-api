import { Hono } from 'hono';
import Stripe from 'stripe';
import { Env } from '../types';
import { customerAuth } from '../middleware';

const customer = new Hono<{ Bindings: Env; Variables: { jwtPayload: Record<string, unknown> } }>();

// Apply customer authentication to all routes
customer.use('*', customerAuth);

// DigitalOcean API base URL
const DO_API = 'https://api.digitalocean.com/v2';

// Cloudflare API base URL
const CF_API = 'https://api.cloudflare.com/client/v4';

// Base domain for customer subdomains
const BASE_DOMAIN = 'optimisingperformance.com.au';

// Sequential counter start
const COUNTER_START = 51;

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
// Cloudflare DNS Helpers
// ============================================================

/**
 * Extract email prefix for subdomain naming.
 * Sanitizes to lowercase alphanumeric + hyphens only.
 */
function emailToPrefix(email: string): string {
  const local = email.split('@')[0] || 'user';
  return local
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    || 'user';
}

/**
 * Query Cloudflare DNS for existing customer subdomains to determine
 * the next sequential counter value.
 * Looks for records matching pattern: *-NN.optimisingperformance.com.au
 */
async function getNextCounter(cfToken: string, zoneId: string): Promise<number> {
  try {
    const res = await fetch(
      `${CF_API}/zones/${zoneId}/dns_records?type=A&per_page=100`,
      { headers: { Authorization: `Bearer ${cfToken}` } }
    );

    if (!res.ok) {
      console.warn(`Cloudflare DNS list failed: ${res.status}`);
      return COUNTER_START;
    }

    const data = (await res.json()) as {
      result: Array<{ name: string }>;
    };

    const escaped = BASE_DOMAIN.replace(/\./g, '\\.');
    const counterRegex = new RegExp(`-(\\d+)\\.${escaped}$`);
    let maxCounter = COUNTER_START - 1;

    for (const record of data.result) {
      const match = record.name.match(counterRegex);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num >= COUNTER_START && num > maxCounter) {
          maxCounter = num;
        }
      }
    }

    const next = maxCounter + 1;
    console.log(`Cloudflare counter: max existing=${maxCounter}, next=${next}`);
    return next;
  } catch (err) {
    console.warn('Counter lookup failed, using default:', err);
    return COUNTER_START;
  }
}

/**
 * Create a proxied Cloudflare DNS A record for a customer subdomain.
 * Proxied = true means Cloudflare handles SSL automatically.
 */
async function createSubdomain(
  cfToken: string,
  zoneId: string,
  email: string,
  ip: string
): Promise<string | null> {
  try {
    const prefix = emailToPrefix(email);
    const counter = await getNextCounter(cfToken, zoneId);
    const subdomain = `${prefix}-${counter}`;
    const fqdn = `${subdomain}.${BASE_DOMAIN}`;

    console.log(`Creating Cloudflare DNS: ${fqdn} -> ${ip} (proxied)`);

    const res = await fetch(`${CF_API}/zones/${zoneId}/dns_records`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'A',
        name: subdomain,
        content: ip,
        proxied: true,
        ttl: 1,
        comment: `Structure customer instance - ${email}`,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error(`Cloudflare DNS creation failed: ${res.status} ${errBody}`);
      return null;
    }

    const result = (await res.json()) as { success: boolean };
    if (result.success) {
      console.log(`Cloudflare DNS created: ${fqdn}`);
      return fqdn;
    }

    return null;
  } catch (err) {
    console.error('Cloudflare DNS creation error:', err);
    return null;
  }
}

/**
 * Check if a Cloudflare DNS record already exists for a given FQDN.
 */
async function findDnsRecord(
  cfToken: string,
  zoneId: string,
  fqdn: string
): Promise<string | null> {
  try {
    const res = await fetch(
      `${CF_API}/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(fqdn)}`,
      { headers: { Authorization: `Bearer ${cfToken}` } }
    );

    if (!res.ok) return null;

    const data = (await res.json()) as {
      result: Array<{ id: string; name: string }>;
    };

    const match = data.result.find((r) => r.name === fqdn);
    return match?.id || null;
  } catch {
    return null;
  }
}

// ============================================================
// DigitalOcean IP Resolution
// ============================================================

/**
 * Retry loop to resolve a Droplet public IP.
 * 5 retries at 3-second intervals = 15 seconds max wait.
 */
async function resolveDropletIp(
  doToken: string,
  dropletId: string
): Promise<string | null> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(`${DO_API}/droplets/${dropletId}`, {
        headers: { Authorization: `Bearer ${doToken}` },
      });

      if (!res.ok) {
        console.warn(`DO IP lookup attempt ${attempt} failed: ${res.status}`);
        if (attempt < 5) await new Promise((r) => setTimeout(r, 3000));
        continue;
      }

      const data = (await res.json()) as {
        droplet: {
          networks?: {
            v4?: Array<{ ip_address: string; type: string }>;
          };
        };
      };

      const publicNet = data.droplet.networks?.v4?.find(
        (n) => n.type === 'public'
      );

      if (publicNet?.ip_address) {
        console.log(`DO IP resolved on attempt ${attempt}: ${publicNet.ip_address}`);
        return publicNet.ip_address;
      }

      console.log(`DO IP not yet assigned, attempt ${attempt}/5, waiting 3s...`);
    } catch (err) {
      console.warn(`DO IP lookup attempt ${attempt} error:`, err);
    }

    if (attempt < 5) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  console.warn('DO IP resolution exhausted all 5 attempts');
  return null;
}

// ============================================================
// Self-Healing Logic
// ============================================================

/**
 * Repairs incomplete provisioning records.
 * 1. IP still "pending" -> queries DigitalOcean for real IP
 * 2. Subdomain missing -> creates Cloudflare DNS record
 * Updates Stripe metadata with healed values.
 */
async function selfHeal(
  stripe: Stripe,
  customerId: string,
  meta: Record<string, string>,
  email: string,
  env: Env
): Promise<{ dropletIp: string; subdomain: string }> {
  let dropletIp = meta.dropletIp || 'pending';
  let subdomain = meta.subdomain || '';
  const dropletId = meta.dropletId || '';
  let healed = false;

  // Heal 1: Resolve pending IP
  if ((dropletIp === 'pending' || !dropletIp) && dropletId) {
    console.log(`Self-healing: resolving IP for droplet ${dropletId}`);
    const resolvedIp = await resolveDropletIp(env.DO_API_TOKEN, dropletId);
    if (resolvedIp) {
      dropletIp = resolvedIp;
      healed = true;
      console.log(`Self-healing: IP resolved to ${resolvedIp}`);
    }
  }

  // Heal 2: Create missing subdomain (only if we have a real IP)
  if (!subdomain && dropletIp && dropletIp !== 'pending') {
    console.log(`Self-healing: creating subdomain for ${email}`);
    const created = await createSubdomain(
      env.CF_API_TOKEN,
      env.CF_ZONE_ID,
      email,
      dropletIp
    );
    if (created) {
      subdomain = created;
      healed = true;
      console.log(`Self-healing: subdomain created: ${created}`);
    }
  }

  // Write healed values back to Stripe
  if (healed) {
    await stripe.customers.update(customerId, {
      metadata: {
        ...meta,
        dropletIp,
        subdomain,
      },
    });
    console.log(`Self-healing: Stripe metadata updated for ${customerId}`);
  }

  return { dropletIp, subdomain };
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

// ============================================================
// Identity Resolution
// ============================================================

interface ClerkEmailAddress {
  email_address: string;
  id: string;
}

interface ClerkUserResponse {
  id: string;
  primary_email_address_id: string | null;
  email_addresses: ClerkEmailAddress[];
}

async function resolveIdentity(
  payload: Record<string, unknown>,
  clerkSecretKey: string
): Promise<{ clerkUserId: string; email: string }> {
  const clerkUserId = (payload.sub as string) || '';

  // Fast path: email present in JWT claims
  const jwtEmail =
    (payload.email as string) ||
    (payload.email_address as string) ||
    '';

  if (jwtEmail) {
    console.log(`Identity resolved from JWT claims: userId=${clerkUserId}, email=${jwtEmail}`);
    return { clerkUserId, email: jwtEmail };
  }

  // Slow path: fetch from Clerk Users API
  if (!clerkUserId) {
    console.warn('Identity resolution failed: no sub claim in JWT');
    return { clerkUserId: '', email: '' };
  }

  try {
    console.log(`JWT email claim absent, fetching from Clerk Users API for userId=${clerkUserId}`);
    const res = await fetch(`https://api.clerk.com/v1/users/${clerkUserId}`, {
      headers: { Authorization: `Bearer ${clerkSecretKey}` },
    });

    if (!res.ok) {
      console.error(`Clerk Users API failed: ${res.status}`);
      return { clerkUserId, email: '' };
    }

    const user = (await res.json()) as ClerkUserResponse;

    let resolvedEmail = '';
    if (user.email_addresses && user.email_addresses.length > 0) {
      if (user.primary_email_address_id) {
        const primary = user.email_addresses.find(
          (e) => e.id === user.primary_email_address_id
        );
        resolvedEmail = primary?.email_address || '';
      }
      if (!resolvedEmail) {
        resolvedEmail = user.email_addresses[0].email_address || '';
      }
    }

    if (resolvedEmail) {
      console.log(`Identity resolved from Clerk API: userId=${clerkUserId}, email=${resolvedEmail}`);
    } else {
      console.warn(`Clerk user ${clerkUserId} has no email addresses`);
    }

    return { clerkUserId, email: resolvedEmail };
  } catch (err) {
    console.error('Clerk Users API call failed:', err);
    return { clerkUserId, email: '' };
  }
}

// ============================================================
// Routes
// ============================================================

/**
 * GET /api/customer/status
 * Returns subscription and provisioning status.
 * Includes self-healing for incomplete provisioning.
 */
customer.get('/status', async (c) => {
  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);
  const payload = c.get('jwtPayload') as Record<string, unknown>;
  const { clerkUserId, email } = await resolveIdentity(payload, c.env.CLERK_SECRET_KEY);

  if (!email) {
    return c.json({
      subscriptionStatus: 'none',
      provisioningStatus: 'none',
      plan: null,
      dropletIp: null,
      dropletRegion: null,
      subdomain: null,
    });
  }

  // Resolve Stripe customer via cache-through
  const customer = await resolveStripeCustomer(stripe, clerkUserId, email, c.env.CLERK_SECRET_KEY);

  if (!customer) {
    return c.json({
      subscriptionStatus: 'none',
      provisioningStatus: 'none',
      plan: null,
      dropletIp: null,
      dropletRegion: null,
      subdomain: null,
    });
  }

  // Get subscription
  const subs = await stripe.subscriptions.list({
    customer: customer.id,
    limit: 1,
    status: 'active',
  });

  const sub = subs.data[0] || null;
  const meta = (customer.metadata || {}) as Record<string, string>;
  const provisioningStatus = meta.provisioningStatus || 'none';

  // Self-heal if provisioning is incomplete
  let dropletIp = meta.dropletIp || null;
  let subdomain = meta.subdomain || null;

  if (
    provisioningStatus === 'provisioned' &&
    (dropletIp === 'pending' || !dropletIp || !subdomain)
  ) {
    console.log(`Self-healing triggered for customer ${customer.id}`);
    const healed = await selfHeal(stripe, customer.id, meta, email, c.env);
    dropletIp = healed.dropletIp;
    subdomain = healed.subdomain;
  }

  return c.json({
    subscriptionStatus: sub ? sub.status : 'none',
    provisioningStatus,
    plan: sub
      ? {
          name: sub.items.data[0]?.price?.product || 'The Structure -- Standard',
          amount: sub.items.data[0]?.price?.unit_amount
            ? sub.items.data[0].price.unit_amount / 100
            : null,
          currency: sub.items.data[0]?.price?.currency || 'aud',
          interval: sub.items.data[0]?.price?.recurring?.interval || 'month',
          currentPeriodEnd: sub.current_period_end
            ? new Date(sub.current_period_end * 1000).toISOString()
            : null,
        }
      : null,
    dropletIp: dropletIp !== 'pending' ? dropletIp : null,
    dropletRegion: meta.dropletRegion || null,
    subdomain: subdomain || null,
  });
});

/**
 * GET /api/customer/regions
 * Returns available DigitalOcean regions.
 */
customer.get('/regions', async (c) => {
  const regionList = Object.entries(REGIONS).map(([name, slug]) => ({
    name,
    slug,
  }));
  return c.json({ regions: regionList });
});

/**
 * POST /api/customer/select-region
 * Customer selects a region after purchase.
 * Provisions a DigitalOcean Droplet, resolves IP, creates Cloudflare subdomain,
 * stores everything in Stripe metadata, and sends welcome email.
 */
customer.post('/select-region', async (c) => {
  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);
  const payload = c.get('jwtPayload') as Record<string, unknown>;
  const { clerkUserId, email } = await resolveIdentity(payload, c.env.CLERK_SECRET_KEY);

  if (!email) {
    return c.json({ error: 'Unable to resolve user identity' }, 400);
  }

  // Resolve Stripe customer
  const cust = await resolveStripeCustomer(stripe, clerkUserId, email, c.env.CLERK_SECRET_KEY);
  if (!cust) {
    return c.json({ error: 'No Stripe customer found for this account' }, 404);
  }

  // Check not already provisioned
  const meta = (cust.metadata || {}) as Record<string, string>;
  if (meta.provisioningStatus === 'provisioned') {
    return c.json({
      error: 'Instance already provisioned',
      subdomain: meta.subdomain || null,
      dropletIp: meta.dropletIp || null,
    }, 409);
  }

  // Validate region
  const body = await c.req.json<{ region: string }>();
  const region = resolveRegion(body.region);
  if (!region) {
    return c.json({ error: `Invalid region: ${body.region}` }, 400);
  }

  console.log(`Provisioning droplet for ${email} in ${region.name} (${region.slug})`);

  // Mark as provisioning
  await stripe.customers.update(cust.id, {
    metadata: {
      ...meta,
      provisioningStatus: 'provisioning',
      dropletRegion: region.name,
    },
  });

  try {
    // Create DigitalOcean Droplet
    const dropletRes = await fetch(`${DO_API}/droplets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${c.env.DO_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `structure-${emailToPrefix(email)}`,
        region: region.slug,
        size: 's-2vcpu-4gb',
        image: 'ubuntu-24-04-x64',
        tags: ['structure', 'customer'],
      }),
    });

    if (!dropletRes.ok) {
      const errText = await dropletRes.text();
      console.error(`DO Droplet creation failed: ${dropletRes.status} ${errText}`);
      // Revert status
      await stripe.customers.update(cust.id, {
        metadata: { ...meta, provisioningStatus: 'failed' },
      });
      return c.json({ error: 'Failed to create instance' }, 502);
    }

    const dropletData = (await dropletRes.json()) as {
      droplet: { id: number };
    };
    const dropletId = String(dropletData.droplet.id);
    console.log(`Droplet created: ID=${dropletId}`);

    // Resolve IP with retry loop (5 attempts, 3s intervals)
    const dropletIp = await resolveDropletIp(c.env.DO_API_TOKEN, dropletId);

    let subdomain: string | null = null;

    if (dropletIp) {
      // Create Cloudflare subdomain
      subdomain = await createSubdomain(
        c.env.CF_API_TOKEN,
        c.env.CF_ZONE_ID,
        email,
        dropletIp
      );
    }

    // Update Stripe metadata with all provisioning data
    const finalMeta: Record<string, string> = {
      ...meta,
      provisioningStatus: 'provisioned',
      dropletId,
      dropletRegion: region.name,
      dropletIp: dropletIp || 'pending',
      subdomain: subdomain || '',
    };

    await stripe.customers.update(cust.id, { metadata: finalMeta });
    console.log(`Stripe metadata updated: dropletId=${dropletId}, ip=${dropletIp}, subdomain=${subdomain}`);

    // Send welcome email via Resend
    const instanceUrl = subdomain
      ? `https://${subdomain}`
      : dropletIp
        ? `http://${dropletIp}`
        : 'Provisioning in progress...';

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
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h1 style="color: #1e40af;">Welcome to The Structure</h1>
              <p>Your dedicated instance has been provisioned successfully.</p>
              <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                <tr>
                  <td style="padding: 8px; border: 1px solid #e5e7eb; font-weight: bold;">Region</td>
                  <td style="padding: 8px; border: 1px solid #e5e7eb;">${region.name}</td>
                </tr>
                <tr>
                  <td style="padding: 8px; border: 1px solid #e5e7eb; font-weight: bold;">Instance URL</td>
                  <td style="padding: 8px; border: 1px solid #e5e7eb;"><a href="${instanceUrl}">${instanceUrl}</a></td>
                </tr>
              </table>
              <p>You can access your instance from the <a href="https://portal.optimisingperformance.com.au">Customer Portal</a>.</p>
              <p style="color: #6b7280; font-size: 12px;">The Structure by Optimising Performance Solutions</p>
            </div>
          `,
        }),
      });
      console.log(`Welcome email sent to ${email}`);
    } catch (emailErr) {
      console.warn('Welcome email failed (non-blocking):', emailErr);
    }

    return c.json({
      success: true,
      dropletId,
      dropletIp: dropletIp || 'pending',
      region: region.name,
      subdomain: subdomain || null,
      instanceUrl,
    });
  } catch (err) {
    console.error('Provisioning error:', err);
    await stripe.customers.update(cust.id, {
      metadata: { ...meta, provisioningStatus: 'failed' },
    });
    return c.json({ error: 'Provisioning failed' }, 500);
  }
});

export { customer };
