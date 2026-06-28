import { Hono } from 'hono';
import { Env } from '../types';
import { adminAuth } from '../middleware';
import { deleteTunnel, deleteCustomerDnsRecords } from '../helpers/cloudflare';

const tenants = new Hono<{ Bindings: Env }>();

// Apply admin authentication to all tenant routes
tenants.use('*', adminAuth);

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
 * Helper: make authenticated requests to DigitalOcean API
 */
async function doFetch(
  token: string,
  path: string,
  method: string = 'GET',
  body?: Record<string, unknown>
): Promise<Response> {
  const opts: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) {
    opts.body = JSON.stringify(body);
  }
  return fetch(`${DO_API}${path}`, opts);
}

/**
 * GET /api/tenants/regions
 * Returns the list of available provisioning regions.
 * NOTE: This route must be defined BEFORE /:id to avoid path conflicts.
 */
tenants.get('/regions', (c) => {
  const regions = Object.entries(REGIONS).map(([name, slug]) => ({
    name,
    slug,
  }));
  return c.json({ regions });
});

/**
 * POST /api/tenants
 * Provision a new tenant Droplet.
 */
tenants.post('/', async (c) => {
  const body = await c.req.json<{
    name: string;
    region: string;
    customerEmail?: string;
    stripeSubscriptionId?: string;
  }>();

  if (!body.name || !body.region) {
    return c.json({ error: 'Missing required fields: name, region' }, 400);
  }

// Resolve region: accept both DO slugs (syd1) and friendly names (Sydney, Australia)
let regionSlug: string;
let regionName: string;

if (VALID_SLUGS.has(body.region)) {
  // Frontend sent a slug directly (e.g. 'syd1')
  regionSlug = body.region;
  regionName = SLUG_TO_NAME[body.region] || body.region;
} else if (REGIONS[body.region]) {
  // Frontend sent a friendly name (e.g. 'Sydney, Australia')
  regionSlug = REGIONS[body.region];
  regionName = body.region;
} else {
  return c.json({
    error: `Invalid region: ${body.region}`,
    validRegions: Object.keys(REGIONS),
    validSlugs: Object.values(REGIONS),
  }, 400);
}

  try {
    const res = await doFetch(c.env.DO_API_TOKEN, '/droplets', 'POST', {
      name: body.name,
      region: regionSlug,
      size: 's-4vcpu-8gb-amd',
      image: 'ubuntu-24-04-x64',
      tags: ['structure-tenant'],
      monitoring: true,
    });

    if (!res.ok) {
      const err = await res.json<{ id: string; message: string }>();
      console.error('DO provision error:', err);
      return c.json({ error: 'Failed to provision Droplet', detail: err.message }, 502);
    }

    const data = await res.json<{ droplet: Record<string, unknown> }>();
    return c.json({
      success: true,
      droplet: {
        id: data.droplet.id,
        name: data.droplet.name,
        region: regionName,
        regionSlug,
        status: data.droplet.status,
        createdAt: data.droplet.created_at,
      },
    }, 201);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Provision error:', message);
    return c.json({ error: 'Internal server error during provisioning' }, 500);
  }
});

/**
 * GET /api/tenants
 * List all tenant Droplets (filtered by structure-tenant tag).
 */
tenants.get('/', async (c) => {
  try {
    const res = await doFetch(
      c.env.DO_API_TOKEN,
      '/droplets?tag_name=structure-tenant&per_page=100'
    );

    if (!res.ok) {
      const err = await res.json<{ message: string }>();
      return c.json({ error: 'Failed to list Droplets', detail: err.message }, 502);
    }

    const data = await res.json<{ droplets: Array<Record<string, unknown>> }>();

    const droplets = data.droplets.map((d: Record<string, unknown>) => {
      const regionObj = d.region as Record<string, unknown> | undefined;
      const networks = d.networks as Record<string, Array<Record<string, unknown>>> | undefined;
      const v4 = networks?.v4 || [];
      const publicNet = v4.find((n: Record<string, unknown>) => n.type === 'public');

      return {
        id: d.id,
        name: d.name,
        status: d.status,
        region: regionObj?.name || d.region,
        regionSlug: regionObj?.slug || '',
        ip: publicNet?.ip_address || 'Pending',
        vcpus: d.vcpus,
        memory: d.memory,
        disk: d.disk,
        createdAt: d.created_at,
        tags: d.tags,
      };
    });

    return c.json({ droplets, total: droplets.length });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('List error:', message);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/tenants/:id
 * Get details for a specific tenant Droplet.
 */
tenants.get('/:id', async (c) => {
  const id = c.req.param('id');

  try {
    const res = await doFetch(c.env.DO_API_TOKEN, `/droplets/${id}`);

    if (!res.ok) {
      if (res.status === 404) {
        return c.json({ error: `Droplet ${id} not found` }, 404);
      }
      const err = await res.json<{ message: string }>();
      return c.json({ error: 'Failed to get Droplet', detail: err.message }, 502);
    }

    const data = await res.json<{ droplet: Record<string, unknown> }>();
    const d = data.droplet;
    const regionObj = d.region as Record<string, unknown> | undefined;
    const networks = d.networks as Record<string, Array<Record<string, unknown>>> | undefined;
    const v4 = networks?.v4 || [];
    const publicNet = v4.find((n: Record<string, unknown>) => n.type === 'public');

    return c.json({
      droplet: {
        id: d.id,
        name: d.name,
        status: d.status,
        region: regionObj?.name || d.region,
        regionSlug: regionObj?.slug || '',
        ip: publicNet?.ip_address || 'Pending',
        vcpus: d.vcpus,
        memory: d.memory,
        disk: d.disk,
        createdAt: d.created_at,
        tags: d.tags,
        image: (d.image as Record<string, unknown>)?.description || '',
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Get error:', message);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * POST /api/tenants/:id/action
 * Perform an action on a tenant Droplet (power_on, power_off, reboot, shutdown).
 */
tenants.post('/:id/action', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ action: string }>();

  const validActions = ['power_on', 'power_off', 'reboot', 'shutdown'];
  if (!body.action || !validActions.includes(body.action)) {
    return c.json({
      error: `Invalid action. Must be one of: ${validActions.join(', ')}`,
    }, 400);
  }

  try {
    const res = await doFetch(c.env.DO_API_TOKEN, `/droplets/${id}/actions`, 'POST', {
      type: body.action,
    });

    if (!res.ok) {
      const err = await res.json<{ message: string }>();
      return c.json({ error: `Failed to ${body.action}`, detail: err.message }, 502);
    }

    const data = await res.json<{ action: Record<string, unknown> }>();
    return c.json({
      success: true,
      action: {
        id: data.action.id,
        type: data.action.type,
        status: data.action.status,
        startedAt: data.action.started_at,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Action error:', message);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * DELETE /api/tenants/:id
 * Destroy a tenant Droplet permanently.
 */
tenants.delete('/:id', async (c) => {
  const id = c.req.param('id');

  try {
    const res = await doFetch(c.env.DO_API_TOKEN, `/droplets/${id}`, 'DELETE');

    if (!res.ok) {
      if (res.status === 404) {
        return c.json({ error: `Droplet ${id} not found` }, 404);
      }
      return c.json({ error: 'Failed to destroy Droplet' }, 502);
    }

    // DO returns 204 No Content on successful delete
    return c.json({ success: true, message: `Droplet ${id} destroyed` });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Delete error:', message);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export { tenants };
