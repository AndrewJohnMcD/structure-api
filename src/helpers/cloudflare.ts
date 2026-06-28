import { Env } from '../types';

// Cloudflare API base URL
const CF_API = 'https://api.cloudflare.com/client/v4';

// Base domain for customer subdomains
const BASE_DOMAIN = 'optimisingperformance.com.au';

/**
 * Delete a Cloudflare Tunnel by ID.
 * Returns true on success, false on failure.
 */
export async function deleteTunnel(
  cfToken: string,
  accountId: string,
  tunnelId: string
): Promise<boolean> {
  try {
    console.log(`Deleting Cloudflare Tunnel: ${tunnelId}`);

    // Cloudflare requires cleaning tunnel connections before deletion
    const cleanRes = await fetch(
      `${CF_API}/accounts/${accountId}/cfd_tunnel/${tunnelId}/connections`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${cfToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!cleanRes.ok) {
      const errBody = await cleanRes.text();
      console.warn(`Tunnel connection cleanup warning: ${cleanRes.status} ${errBody}`);
      // Continue -- deletion may still succeed
    }

    // Delete the tunnel itself
    const res = await fetch(
      `${CF_API}/accounts/${accountId}/cfd_tunnel/${tunnelId}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${cfToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!res.ok) {
      const errBody = await res.text();
      console.error(`Tunnel deletion failed: ${res.status} ${errBody}`);
      return false;
    }

    const data = (await res.json()) as { success: boolean };
    if (data.success) {
      console.log(`Tunnel deleted: ${tunnelId}`);
      return true;
    }

    console.error('Tunnel deletion response indicated failure');
    return false;
  } catch (err) {
    console.error('Tunnel deletion error:', err);
    return false;
  }
}

/**
 * Delete all CNAME DNS records matching a given name (exact match).
 * Used to clean up both main and wildcard records.
 * Returns true on success, false on failure.
 */
export async function deleteCnameRecord(
  cfToken: string,
  zoneId: string,
  recordName: string
): Promise<boolean> {
  try {
    // Resolve the full record name if it doesn't already include the base domain
    const fullName = recordName.includes('.')
      ? recordName
      : `${recordName}.${BASE_DOMAIN}`;

    console.log(`Deleting CNAME record: ${fullName}`);

    // Find matching records
    const listRes = await fetch(
      `${CF_API}/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(fullName)}&per_page=50`,
      {
        headers: { Authorization: `Bearer ${cfToken}` },
      }
    );

    if (!listRes.ok) {
      const errBody = await listRes.text();
      console.error(`DNS record lookup failed for ${fullName}: ${listRes.status} ${errBody}`);
      return false;
    }

    const listData = (await listRes.json()) as {
      success: boolean;
      result: Array<{ id: string; name: string }>;
    };

    if (!listData.result || listData.result.length === 0) {
      console.log(`No CNAME record found for ${fullName}, nothing to delete`);
      return true; // Not an error -- record may have already been cleaned up
    }

    // Delete each matching record
    let allDeleted = true;
    for (const record of listData.result) {
      const delRes = await fetch(
        `${CF_API}/zones/${zoneId}/dns_records/${record.id}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${cfToken}` },
        }
      );

      if (delRes.ok) {
        console.log(`Deleted CNAME record: ${record.name} (ID: ${record.id})`);
      } else {
        const errBody = await delRes.text();
        console.error(`Failed to delete CNAME ${record.name} (ID: ${record.id}): ${delRes.status} ${errBody}`);
        allDeleted = false;
      }
    }

    return allDeleted;
  } catch (err) {
    console.error(`CNAME deletion error for ${recordName}:`, err);
    return false;
  }
}

/**
 * Full DNS cleanup for a customer instance.
 * Deletes both the main CNAME and wildcard CNAME records.
 *
 * @param subdomain - The customer subdomain prefix (e.g., "andrewjohnmc2015-99")
 *                    or full FQDN (e.g., "andrewjohnmc2015-99.optimisingperformance.com.au")
 */
export async function deleteCustomerDnsRecords(
  cfToken: string,
  zoneId: string,
  subdomain: string
): Promise<{ main: boolean; wildcard: boolean }> {
  // Extract the prefix if a full FQDN was provided
  const prefix = subdomain.replace(`.${BASE_DOMAIN}`, '');
  const fqdn = `${prefix}.${BASE_DOMAIN}`;
  const wildcardFqdn = `*.${prefix}.${BASE_DOMAIN}`;

  console.log(`Cleaning up DNS records for customer: ${fqdn}`);

  const main = await deleteCnameRecord(cfToken, zoneId, fqdn);
  const wildcard = await deleteCnameRecord(cfToken, zoneId, wildcardFqdn);

  console.log(`DNS cleanup complete: main=${main}, wildcard=${wildcard}`);
  return { main, wildcard };
}
