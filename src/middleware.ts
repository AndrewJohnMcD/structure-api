import { Context, Next } from 'hono';
import { Env } from './types';

// --- CORS Middleware ---
export const corsMiddleware = async (c: Context<{ Bindings: Env }>, next: Next) => {
  const allowedOrigins = c.env.ALLOWED_ORIGINS?.split(',') || [];
  const origin = c.req.header('Origin') || '';

  if (allowedOrigins.includes(origin)) {
    c.header('Access-Control-Allow-Origin', origin);
  }

  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  c.header('Access-Control-Max-Age', '86400');

  if (c.req.method === 'OPTIONS') {
    return c.text('', 204);
  }

  await next();
};

// --- JWKS Cache ---
let cachedJWKS: JsonWebKey | null = null;
let jwksCachedAt = 0;
const JWKS_CACHE_TTL = 3600000; // 1 hour in ms

async function getClerkPublicKey(jwksUrl: string): Promise<CryptoKey> {
  const now = Date.now();

  if (!cachedJWKS || now - jwksCachedAt > JWKS_CACHE_TTL) {
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

    cachedJWKS = signingKey;
    jwksCachedAt = now;
  }

  return crypto.subtle.importKey(
    'jwk',
    cachedJWKS,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
}

function base64UrlDecode(str: string): Uint8Array {
  // Convert base64url to base64
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  // Pad with = if needed
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

async function verifyJWT(token: string, jwksUrl: string): Promise<boolean> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;

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

    if (!isValid) return false;

    // Check expiration
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
    const now = Math.floor(Date.now() / 1000);

    if (payload.exp && payload.exp < now) return false;
    if (payload.nbf && payload.nbf > now) return false;

    return true;
  } catch {
    return false;
  }
}

// --- Admin Auth Middleware (Clerk JWT Verification) ---
export const adminAuth = async (c: Context<{ Bindings: Env }>, next: Next) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  const token = authHeader.slice(7);

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
