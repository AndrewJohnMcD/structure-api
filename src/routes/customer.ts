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

// Golden snapshot ID (pre-built Structure instance with Docker + images cached)
const GOLDEN_SNAPSHOT_ID = 232693913;

// Customer Droplet specification
const DROPLET_SIZE = 's-4vcpu-8gb-intel';

// Snapshot region lock (snapshot only exists in SGP1)
const SNAPSHOT_REGION = 'sgp1';

// Region mapping: friendly name -> DO slug
// Currently locked to Singapore while golden snapshot is SGP1-only.
// Additional regions require snapshot distribution (Sprint 2 backlog).
const REGIONS: Record<string, string> = {
  'Singapore': 'sgp1',
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
// Cloudflare Tunnel Helpers
// ============================================================

/**
 * Generate a cryptographically random tunnel secret.
 * Returns a 32-byte random value as base64 (Cloudflare Tunnel requirement).
 */
function generateTunnelSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Create a Cloudflare Tunnel via the API.
 * Returns the tunnel ID on success, or null on failure.
 */
async function createTunnel(
  cfToken: string,
  accountId: string,
  tunnelName: string,
  tunnelSecret: string
): Promise<string | null> {
  try {
    console.log(`Creating Cloudflare Tunnel: ${tunnelName}`);

    const res = await fetch(
      `${CF_API}/accounts/${accountId}/cfd_tunnel`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: tunnelName,
          tunnel_secret: tunnelSecret,
          config_src: 'local',
        }),
      }
    );

    if (!res.ok) {
      const errBody = await res.text();
      console.error(`Tunnel creation failed: ${res.status} ${errBody}`);
      return null;
    }

    const data = (await res.json()) as {
      success: boolean;
      result: { id: string };
    };

    if (!data.success || !data.result?.id) {
      console.error('Tunnel creation response missing ID');
      return null;
    }

    console.log(`Tunnel created: ID=${data.result.id}`);
    return data.result.id;
  } catch (err) {
    console.error('Tunnel creation error:', err);
    return null;
  }
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
 * Checks both CNAME and A records to avoid collisions with legacy entries.
 */
async function getNextCounter(cfToken: string, zoneId: string): Promise<number> {
  try {
    const escaped = BASE_DOMAIN.replace(/\./g, '\\.');
    const counterRegex = new RegExp(`-(\\d+)\\.${escaped}$`);
    let maxCounter = COUNTER_START - 1;

    // Check CNAME records (new tunnel-based subdomains)
    const resCname = await fetch(
      `${CF_API}/zones/${zoneId}/dns_records?type=CNAME&per_page=100`,
      { headers: { Authorization: `Bearer ${cfToken}` } }
    );
    if (resCname.ok) {
      const dataCname = (await resCname.json()) as { result: Array<{ name: string }> };
      for (const record of dataCname.result) {
        const match = record.name.match(counterRegex);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num >= COUNTER_START && num > maxCounter) maxCounter = num;
        }
      }
    }

    // Check A records (legacy direct-IP subdomains)
    const resA = await fetch(
      `${CF_API}/zones/${zoneId}/dns_records?type=A&per_page=100`,
      { headers: { Authorization: `Bearer ${cfToken}` } }
    );
    if (resA.ok) {
      const dataA = (await resA.json()) as { result: Array<{ name: string }> };
      for (const record of dataA.result) {
        const match = record.name.match(counterRegex);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num >= COUNTER_START && num > maxCounter) maxCounter = num;
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
 * Create a proxied Cloudflare CNAME record pointing to a tunnel.
 * Proxied = true means Cloudflare handles SSL automatically.
 */
async function createCnameRecord(
  cfToken: string,
  zoneId: string,
  name: string,
  tunnelId: string,
  comment: string
): Promise<boolean> {
  try {
    const target = `${tunnelId}.cfargotunnel.com`;
    console.log(`Creating CNAME: ${name} -> ${target}`);

    const res = await fetch(`${CF_API}/zones/${zoneId}/dns_records`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'CNAME',
        name,
        content: target,
        proxied: true,
        ttl: 1,
        comment,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error(`CNAME creation failed for ${name}: ${res.status} ${errBody}`);
      return false;
    }

    const result = (await res.json()) as { success: boolean };
    if (result.success) {
      console.log(`CNAME created: ${name}`);
      return true;
    }
    return false;
  } catch (err) {
    console.error(`CNAME creation error for ${name}:`, err);
    return false;
  }
}

// ============================================================
// Cloud-Init Builder
// ============================================================

/**
 * Build the cloud-init user_data script that configures a fresh
 * Droplet booted from the golden snapshot.
 *
 * This script runs once on first boot and:
 * 1. Writes cloudflared credentials.json
 * 2. Writes cloudflared config.yml with ingress rules
 * 3. Updates .env with the customer's STRUCTURE_DOMAIN
 * 4. Starts the full 16-container stack via docker compose
 */
function buildCloudInit(
  tunnelId: string,
  tunnelSecret: string,
  accountId: string,
  subdomain: string
): string {
  const fqdn = `${subdomain}.${BASE_DOMAIN}`;

  // Build the cloud-init script using heredocs for reliable multi-line file writing.
  // Template literals handle JS interpolation; bash variables use literal ${} in single-quoted lines.
  const script = `#!/bin/bash
set -euo pipefail

# Log all output for debugging
exec > /var/log/structure-init.log 2>&1
echo "[$(date)] Structure cloud-init starting"

# --- 1. Write Cloudflare Tunnel credentials ---
mkdir -p /root/TheStructure-Quantum-2/infrastructure/cloudflared
cat > /root/TheStructure-Quantum-2/infrastructure/cloudflared/credentials.json << 'CRED_EOF'
{"AccountTag":"${accountId}","TunnelID":"${tunnelId}","TunnelSecret":"${tunnelSecret}"}
CRED_EOF
chown 65532:65532 /root/TheStructure-Quantum-2/infrastructure/cloudflared/credentials.json
chmod 600 /root/TheStructure-Quantum-2/infrastructure/cloudflared/credentials.json
echo "[$(date)] Tunnel credentials written"

# --- 2. Write Cloudflare Tunnel config ---
cat > /root/TheStructure-Quantum-2/infrastructure/cloudflared/config.yml << 'CONFIG_EOF'
tunnel: ${tunnelId}
credentials-file: /etc/cloudflared/credentials.json

ingress:
  - hostname: ${fqdn}
    service: http://nginx:80
  - hostname: "*.${fqdn}"
    service: http://nginx-tools:80
  - hostname: ssh.${fqdn}
    service: ssh://host.docker.internal:22
  - service: http_status:404
CONFIG_EOF
echo "[$(date)] Tunnel config written"

# --- 3. Update STRUCTURE_DOMAIN in .env ---
cd /root/TheStructure-Quantum-2
if [ -f .env ]; then
  sed -i 's|^STRUCTURE_DOMAIN=.*|STRUCTURE_DOMAIN=${fqdn}|' .env
  echo "[$(date)] STRUCTURE_DOMAIN updated to ${fqdn}"
else
  echo "[$(date)] WARNING: .env not found, skipping domain update"
fi

# --- 4. Start the full stack ---
cd /root/TheStructure-Quantum-2
docker compose up -d
echo "[$(date)] Docker Compose started"

# --- 5. Wait for containers to stabilize ---
sleep 10
RUNNING=$(docker ps --format "{{.Names}}" | wc -l)
echo "[$(date)] Structure cloud-init complete. $RUNNING containers running."
`;

  return script;
}

// ============================================================
// DigitalOcean IP Resolution
// ============================================================

/**
 * Retry loop to resolve a Droplet public IP.
 * 5 retries at 3-second intervals = 15 seconds max wait.
 * Used for metadata recording (not DNS -- tunnel handles routing).
 */
async function resolveDropletIp(
  doToken: string,
  dropletId: string
): Promise<string | null> {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const res = await fetch(`${DO_API}/droplets/${dropletId}`, {
        headers: { Authorization: `Bearer ${doToken}` },
      });

      if (!res.ok) {
        console.warn(`DO IP lookup attempt ${attempt} failed: ${res.status}`);
        if (attempt < 10) await new Promise((r) => setTimeout(r, 5000));
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

      console.log(`DO IP not yet assigned, attempt ${attempt}/10, waiting 5s...`);
    } catch (err) {
      console.warn(`DO IP lookup attempt ${attempt} error:`, err);
    }

    if (attempt < 10) {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  console.warn('DO IP resolution exhausted all 10 attempts');
  return null;
}


// ============================================================
// Instance Readiness Probe
// ============================================================

/**
 * Probe whether a customer's subdomain is responding.
 * Uses cache-busting query string and no-cache headers to bypass
 * Cloudflare edge caching and hit the origin directly.
 * Returns true if the subdomain responds with any HTTP status (even 401/403),
 * which confirms the tunnel + containers are up.
 */
async function probeInstanceReady(subdomain: string): Promise<boolean> {
  if (!subdomain) return false;

  try {
    const cacheBuster = `_t=${Date.now()}`;
    const url = `https://${subdomain}?${cacheBuster}`;
    console.log(`Readiness probe: ${url}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(url, {
      method: 'HEAD',
      headers: {
        'Cache-Control': 'no-cache, no-store',
        Pragma: 'no-cache',
      },
      signal: controller.signal,
      redirect: 'manual',
    });

    clearTimeout(timeout);

    // Any HTTP response means the tunnel is connected and containers are serving.
    // 502/503 from Cloudflare means tunnel exists but origin isn't ready yet.
    const ready = res.status < 500;
    console.log(`Readiness probe result: status=${res.status}, ready=${ready}`);
    return ready;
  } catch (err) {
    // Network error, timeout, or Cloudflare 521/522/523 = not ready
    console.log(`Readiness probe failed (instance not ready yet):`, err);
    return false;
  }
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
// Self-Healing Logic
// ============================================================

/**
 * Repairs incomplete provisioning records.
 * For tunnel-based deployments, self-healing focuses on:
 * 1. IP still "pending" -> queries DigitalOcean for real IP (metadata only)
 * 2. Subdomain or tunnel missing -> logs warning (requires manual intervention)
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
  const subdomain = meta.subdomain || '';
  const dropletId = meta.dropletId || '';
  let healed = false;

  // Heal: Resolve pending IP (for metadata/monitoring only)
  if ((dropletIp === 'pending' || !dropletIp) && dropletId) {
    console.log(`Self-healing: resolving IP for droplet ${dropletId}`);
    const resolvedIp = await resolveDropletIp(env.DO_API_TOKEN, dropletId);
    if (resolvedIp) {
      dropletIp = resolvedIp;
      healed = true;
      console.log(`Self-healing: IP resolved to ${resolvedIp}`);
    }
  }

  // Write healed values back to Stripe
  if (healed) {
    await stripe.customers.update(customerId, {
      metadata: {
        ...meta,
        dropletIp,
      },
    });
    console.log(`Self-healing: Stripe metadata updated for ${customerId}`);
  }

  return { dropletIp, subdomain };
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
  const cust = await resolveStripeCustomer(stripe, clerkUserId, email, c.env.CLERK_SECRET_KEY);

  if (!cust) {
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
    customer: cust.id,
    limit: 1,
    status: 'active',
  });

  const sub = subs.data[0] || null;
  const meta = (cust.metadata || {}) as Record<string, string>;
  const provisioningStatus = meta.provisioningStatus || 'none';

  // Self-heal if provisioning is incomplete
  let dropletIp = meta.dropletIp || null;
  let subdomain = meta.subdomain || null;

  if (
    provisioningStatus === 'provisioned' &&
    (dropletIp === 'pending' || !dropletIp)
  ) {
    console.log(`Self-healing triggered for customer ${cust.id}`);
    const healed = await selfHeal(stripe, cust.id, meta, email, c.env);
    dropletIp = healed.dropletIp;
    subdomain = healed.subdomain;
  }

  // Probe instance readiness if subdomain exists
  const instanceReady = subdomain ? await probeInstanceReady(subdomain) : false;

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
    instanceReady,
  });
});

/**
 * GET /api/customer/regions
 * Returns available DigitalOcean regions.
 * Currently locked to Singapore (golden snapshot location).
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
 *
 * Customer selects a region after purchase.
 * Executes the tunnel-first provisioning sequence:
 *
 * 1. Generate tunnel secret
 * 2. Determine unique subdomain (email-prefix-NN)
 * 3. Create Cloudflare Tunnel
 * 4. Create CNAME DNS records (subdomain + wildcard)
 * 5. Build cloud-init user_data script
 * 6. Create DigitalOcean Droplet from golden snapshot
 * 7. Resolve Droplet IP (metadata only -- tunnel handles routing)
 * 8. Update Stripe metadata
 * 9. Send welcome email
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

  // Resolve region: use provided value or default to SGP1
  const body = await c.req.json<{ region?: string }>();
  const region = body.region ? resolveRegion(body.region) : resolveRegion(SNAPSHOT_REGION);
  if (!region) {
    return c.json({
      error: `Invalid region: ${body.region}. Currently available: Singapore (sgp1)`,
      availableRegions: Object.entries(REGIONS).map(([name, slug]) => ({ name, slug })),
    }, 400);
  }

  console.log(`=== PROVISIONING START: ${email} in ${region.name} (${region.slug}) ===`);

  // Mark as provisioning
  await stripe.customers.update(cust.id, {
    metadata: {
      ...meta,
      provisioningStatus: 'provisioning',
      dropletRegion: region.name,
    },
  });

  try {
    // --- Step 1: Generate tunnel secret ---
    const tunnelSecret = generateTunnelSecret();
    console.log('Step 1/9: Tunnel secret generated');

    // --- Step 2: Determine unique subdomain ---
    const prefix = emailToPrefix(email);
    const counter = await getNextCounter(c.env.CF_API_TOKEN, c.env.CF_ZONE_ID);
    const subdomain = `${prefix}-${counter}`;
    const fqdn = `${subdomain}.${BASE_DOMAIN}`;
    console.log(`Step 2/9: Subdomain determined: ${fqdn}`);

    // --- Step 3: Create Cloudflare Tunnel ---
    const tunnelName = `structure-${subdomain}`;
    const tunnelId = await createTunnel(
      c.env.CF_API_TOKEN,
      c.env.CF_ACCOUNT_ID,
      tunnelName,
      tunnelSecret
    );

    if (!tunnelId) {
      console.error('PROVISIONING FAILED: Tunnel creation failed');
      await stripe.customers.update(cust.id, {
        metadata: { ...meta, provisioningStatus: 'failed' },
      });
      return c.json({ error: 'Failed to create secure tunnel' }, 502);
    }
    console.log(`Step 3/9: Tunnel created: ${tunnelId}`);

    // --- Step 4: Create CNAME DNS records ---
    const mainCname = await createCnameRecord(
      c.env.CF_API_TOKEN,
      c.env.CF_ZONE_ID,
      subdomain,
      tunnelId,
      `Structure customer instance - ${email}`
    );

    const wildcardCname = await createCnameRecord(
      c.env.CF_API_TOKEN,
      c.env.CF_ZONE_ID,
      `*.${subdomain}`,
      tunnelId,
      `Structure customer tools wildcard - ${email}`
    );

    if (!mainCname) {
      console.error('PROVISIONING WARNING: Main CNAME creation failed');
      // Continue -- tunnel exists, DNS can be fixed manually
    }
    if (!wildcardCname) {
      console.error('PROVISIONING WARNING: Wildcard CNAME creation failed');
      // Continue -- main subdomain may still work
    }
    console.log(`Step 4/9: DNS records created (main=${mainCname}, wildcard=${wildcardCname})`);

    // --- Step 5: Build cloud-init user_data ---
    const userData = buildCloudInit(
      tunnelId,
      tunnelSecret,
      c.env.CF_ACCOUNT_ID,
      subdomain
    );
    console.log('Step 5/9: Cloud-init script built');

    // --- Step 6: Create DigitalOcean Droplet from golden snapshot ---
    const dropletRes = await fetch(`${DO_API}/droplets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${c.env.DO_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `structure-${subdomain}`,
        region: SNAPSHOT_REGION,
        size: DROPLET_SIZE,
        image: GOLDEN_SNAPSHOT_ID,
        tags: ['structure', 'customer'],
        user_data: userData,
        monitoring: true,
      }),
    });

    if (!dropletRes.ok) {
      const errText = await dropletRes.text();
      console.error(`DO Droplet creation failed: ${dropletRes.status} ${errText}`);
      await stripe.customers.update(cust.id, {
        metadata: { ...meta, provisioningStatus: 'failed' },
      });
      return c.json({ error: 'Failed to create instance' }, 502);
    }

    const dropletData = (await dropletRes.json()) as {
      droplet: { id: number };
    };
    const dropletId = String(dropletData.droplet.id);
    console.log(`Step 6/9: Droplet created from snapshot: ID=${dropletId}`);

    // --- Step 7: Resolve Droplet IP (metadata only) ---
    const dropletIp = await resolveDropletIp(c.env.DO_API_TOKEN, dropletId);
    console.log(`Step 7/9: Droplet IP=${dropletIp || 'pending'}`);

    // --- Step 8: Update Stripe metadata ---
    const finalMeta: Record<string, string> = {
      ...meta,
      provisioningStatus: 'provisioned',
      dropletId,
      dropletRegion: region.name,
      dropletIp: dropletIp || 'pending',
      subdomain: fqdn,
      tunnelId,
      tunnelName,
    };

    await stripe.customers.update(cust.id, { metadata: finalMeta });
    console.log('Step 8/9: Stripe metadata updated');

    const instanceUrl = `https://${fqdn}`;

    // --- Step 9: Send welcome email (gated behind IP resolution) ---
    if (dropletIp) {
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
              <p>Your dedicated quantum orchestration instance has been provisioned and is starting up.</p>
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
              <p><strong>Please allow 3-5 minutes</strong> for your instance to fully initialize on first boot.</p>
              <p>You can access your instance from the <a href="https://portal.optimisingperformance.com.au">Customer Portal</a> or directly via the URL above.</p>
              <p style="color: #6b7280; font-size: 12px;">The Structure by Optimising Performance Solutions</p>
            </div>
          `,
        }),
      });
      console.log(`Step 9/9: Welcome email sent to ${email}`);
    } catch (emailErr) {
      console.warn('Welcome email failed (non-blocking):', emailErr);
    }
    } else {
      console.warn('Step 9/9: DEFERRED - IP not yet resolved, welcome email skipped');
    }

    console.log(`=== PROVISIONING COMPLETE: ${email} -> ${fqdn} ===`);

    return c.json({
      success: true,
      dropletId,
      dropletIp: dropletIp || 'pending',
      region: region.name,
      subdomain: fqdn,
      instanceUrl,
      tunnelId,
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
