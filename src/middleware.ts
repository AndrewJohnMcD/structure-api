import { Context, Next } from 'hono';
import { Env } from './types';

// --- CORS Middleware ---
export const corsMiddleware = async (c: Context<{ Bindings: Env }>, next: Next) => {
  const allowedOrigins = c.env.ALLOWED_ORIGINS?.split(',') || [];
  const origin = c.req.header('Origin') || '';

  if (allowedOrigins.includes(origin)) {
    c.header('Access-Control-Allow-Origin', origin);
  } else if (origin) {
    console.warn(`CORS: rejected origin "${origin}". Allowed: ${allowedOrigins.join(', ')}`);
  }

  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  c.header('Access-Control-Max-Age', '86400');

  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204);
  }

  await next();
};

// --- JWKS Cache (keyed by URL to support multiple Clerk instances) ---
interface JWKSCacheEntry {
  key: JsonWebKey;
  cachedAt: number;
}

const jwksCache = new Map<string, JWKSCacheEntry>();
const JWKS_CACHE_TTL = 3600000; // 1 hour in ms

// Clock skew tolerance in seconds.
// Clerk issues short-lived tokens (60s). This generous tolerance absorbs
// clock drift between Clerk servers and Cloudflare edge nodes, network
// latency, and token transit time. Both admin and customer consoles are
// already gated behind Clerk authentication -- this JWT is a secondary
// verification layer, so generosity here costs nothing in security.
const CLOCK_SKEW_TOLERANCE = 120; // 2 minutes

async function getClerkPublicKey(jwksUrl: string): Promise<CryptoKey> {
  const now = Date.now();
  const cached = jwksCache.get(jwksUrl);

  if (!cached || now - cached.cachedAt > JWKS_CACHE_TTL) {
    const response = await fetch(jwksUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch JWKS: ${response.status}`);
    }
    const jwks = await response.json() as { keys: JsonWebKey[] };

    // Find the RS256 signing key
    const signingKey = jwks.keys.find(
      (key: any) => key.kty === 'RSA' && key.use === 'sig' && key.alg === 'RS256'
    );
    if (!signingKey) {
      throw new Error('No RS256 signing key found in JWKS');
    }

    jwksCache.set(jwksUrl, { key: signingKey, cachedAt: now });
  }

  const entry = jwksCache.get(jwksUrl)!;
  return crypto.subtle.importKey(
    'jwk',
    entry.key,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
}

function base64UrlDecode(str: string): Uint8Array {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Verify a JWT and return the decoded payload if valid, or null if invalid.
 * Used by both admin and customer auth middleware.
 */
async function verifyAndDecodeJWT(
  token: string,
  jwksUrl: string
): Promise<Record<string, unknown> | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;

    // Verify the signature
    const publicKey = await getClerkPublicKey(jwksUrl);
    const signedContent = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = base64UrlDecode(signatureB64);

    const isValid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      signature,
      signedContent
    );

    if (!isValid) return null;

    // Decode and validate claims
    const payload = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(payloadB64))
    ) as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);

    if (payload.exp && ((payload.exp as number) + CLOCK_SKEW_TOLERANCE) < now) return null;
    if (payload.nbf && ((payload.nbf as number) - CLOCK_SKEW_TOLERANCE) > now) return null;

    return payload;
  } catch {
    return null;
  }
}

// Backward-compatible boolean wrapper used by adminAuth
async function verifyJWT(token: string, jwksUrl: string): Promise<boolean> {
  const payload = await verifyAndDecodeJWT(token, jwksUrl);
  return payload !== null;
}

// --- Helper: extract and verify Bearer token ---
function extractBearerToken(c: Context<{ Bindings: Env }>): string | null {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}

// --- Admin Auth Middleware (Clerk JWT via Admin instance) ---
export const adminAuth = async (c: Context<{ Bindings: Env }>, next: Next) => {
  const token = extractBearerToken(c);

  if (!token) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  if (!c.env.CLERK_JWKS_URL) {
    console.error('CLERK_JWKS_URL not configured');
    return c.json({ error: 'Authentication service misconfigured' }, 500);
  }

  const isValid = await verifyJWT(token, c.env.CLERK_JWKS_URL);

  if (!isValid) {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }

  await next();
};

// --- Customer Auth Middleware (Clerk JWT via Customer instance) ---
// Verifies tokens issued by the customer-facing Clerk instance and
// stores the decoded JWT payload on the Hono context for downstream
// route handlers to access customer identity (email, sub, etc.).
export const customerAuth = async (c: Context<{ Bindings: Env }>, next: Next) => {
  const token = extractBearerToken(c);

  if (!token) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  if (!c.env.CLERK_CUSTOMER_JWKS_URL) {
    console.error('CLERK_CUSTOMER_JWKS_URL not configured');
    return c.json({ error: 'Authentication service misconfigured' }, 500);
  }

  const payload = await verifyAndDecodeJWT(token, c.env.CLERK_CUSTOMER_JWKS_URL);

  if (!payload) {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }

  // Store decoded claims for route handlers.
  // Clerk JWTs include: sub (user ID), email, azp (authorized party), etc.
  c.set('jwtPayload', payload);

  await next();
};


// --- Identity Verification Guard ---
// Runs AFTER customerAuth. Checks that the authenticated user has completed
// Stripe Identity verification. Checks JWT public_metadata first (zero-cost),
// falls back to Clerk Users API if the claim is absent.
//
// Usage: mount on routes that require verified identity.
// Do NOT mount on create-verification-session (chicken-and-egg).
export const verificationGuard = async (c: Context<{ Bindings: Env; Variables: { jwtPayload: Record<string, unknown> } }>, next: Next) => {
  const payload = c.get('jwtPayload') as Record<string, unknown>;

  // Fast path: check JWT public_metadata claim
  const publicMeta = (payload.public_metadata ?? payload.publicMetadata) as Record<string, unknown> | undefined;
  if (publicMeta?.identity_verified === true) {
    await next();
    return;
  }

  // Slow path: JWT may not include metadata yet (token issued before verification).
  // Query Clerk Users API as authoritative source.
  const clerkUserId = payload.sub as string;
  if (clerkUserId && c.env.CLERK_SECRET_KEY) {
    try {
      const res = await fetch(`https://api.clerk.com/v1/users/${clerkUserId}`, {
        headers: { Authorization: `Bearer ${c.env.CLERK_SECRET_KEY}` },
      });

      if (res.ok) {
        const user = (await res.json()) as { public_metadata?: Record<string, unknown> };
        if (user.public_metadata?.identity_verified === true) {
          await next();
          return;
        }
      }
    } catch (err) {
      console.error('Verification guard: Clerk API check failed:', err);
      // Fail closed: if we can't verify, block access
    }
  }

  return c.json({
    error: 'Identity verification required',
    message: 'Please complete identity verification before accessing this resource.',
    action: 'create-verification-session',
  }, 403);
};
