import { Hono } from 'hono';
import { Env } from './types';
import { corsMiddleware } from './middleware';
import { checkout } from './routes/checkout';
import { billing } from './routes/billing';
import { enterprise } from './routes/enterprise';
import { referral } from './routes/referral';
import { affiliate } from './routes/affiliate';
import { tenants } from './routes/tenants';

const app = new Hono<{ Bindings: Env }>();

// Apply CORS to all routes
app.use('*', corsMiddleware);

// Health check
app.get('/api/health', (c) => {
  return c.json({
    status: 'operational',
    service: 'structure-api',
    timestamp: new Date().toISOString(),
  });
});

// --- TEMPORARY DIAGNOSTIC ENDPOINT (REMOVE AFTER DEBUG) ---
app.get('/api/debug-auth', async (c) => {
  const diagnostics: Record<string, any> = {
    timestamp: new Date().toISOString(),
    steps: [],
  };

  // Step 1: Check Authorization header
  const authHeader = c.req.header('Authorization');
  if (!authHeader) {
    diagnostics.steps.push({ step: 1, name: 'auth_header', status: 'FAIL', detail: 'No Authorization header present' });
    return c.json(diagnostics);
  }
  if (!authHeader.startsWith('Bearer ')) {
    diagnostics.steps.push({ step: 1, name: 'auth_header', status: 'FAIL', detail: `Header does not start with Bearer. Starts with: ${authHeader.substring(0, 20)}` });
    return c.json(diagnostics);
  }
  const token = authHeader.slice(7);
  diagnostics.steps.push({ step: 1, name: 'auth_header', status: 'PASS', detail: `Token length: ${token.length} chars` });

  // Step 2: Decode JWT parts (no verification)
  const parts = token.split('.');
  if (parts.length !== 3) {
    diagnostics.steps.push({ step: 2, name: 'jwt_structure', status: 'FAIL', detail: `Expected 3 parts, got ${parts.length}` });
    return c.json(diagnostics);
  }
  diagnostics.steps.push({ step: 2, name: 'jwt_structure', status: 'PASS', detail: '3 parts found' });

  // Step 3: Decode header
  try {
    const headerB64 = parts[0].replace(/-/g, '+').replace(/_/g, '/');
    const headerJson = JSON.parse(atob(headerB64));
    diagnostics.jwt_header = headerJson;
    diagnostics.steps.push({ step: 3, name: 'jwt_header_decode', status: 'PASS', detail: headerJson });
  } catch (e: any) {
    diagnostics.steps.push({ step: 3, name: 'jwt_header_decode', status: 'FAIL', detail: e.message });
    return c.json(diagnostics);
  }

  // Step 4: Decode payload
  try {
    let payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (payloadB64.length % 4 !== 0) payloadB64 += '=';
    const payloadJson = JSON.parse(atob(payloadB64));
    // Redact sensitive fields but show structure
    const safePayload = { ...payloadJson };
    if (safePayload.sub) safePayload.sub = safePayload.sub.substring(0, 10) + '...';
    if (safePayload.sid) safePayload.sid = safePayload.sid.substring(0, 10) + '...';
    diagnostics.jwt_payload = safePayload;

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    diagnostics.server_time_unix = now;
    if (payloadJson.exp) {
      const expDelta = payloadJson.exp - now;
      diagnostics.steps.push({
        step: 4, name: 'jwt_payload_decode', status: 'PASS',
        detail: `exp=${payloadJson.exp}, now=${now}, delta=${expDelta}s (${expDelta > 0 ? 'VALID' : 'EXPIRED'})`
      });
      if (expDelta <= 0) {
        diagnostics.steps.push({ step: '4b', name: 'expiration_check', status: 'FAIL', detail: `Token expired ${Math.abs(expDelta)} seconds ago` });
      }
    }
    if (payloadJson.nbf) {
      const nbfDelta = now - payloadJson.nbf;
      diagnostics.steps.push({
        step: '4c', name: 'nbf_check', status: nbfDelta >= 0 ? 'PASS' : 'FAIL',
        detail: `nbf=${payloadJson.nbf}, now=${now}, delta=${nbfDelta}s`
      });
    }
  } catch (e: any) {
    diagnostics.steps.push({ step: 4, name: 'jwt_payload_decode', status: 'FAIL', detail: e.message });
    return c.json(diagnostics);
  }

  // Step 5: Fetch JWKS
  const jwksUrl = c.env.CLERK_JWKS_URL;
  diagnostics.jwks_url_configured = jwksUrl ? jwksUrl : 'NOT SET';

  if (!jwksUrl) {
    diagnostics.steps.push({ step: 5, name: 'jwks_fetch', status: 'FAIL', detail: 'CLERK_JWKS_URL not configured' });
    return c.json(diagnostics);
  }

  let signingKey: JsonWebKey | null = null;
  try {
    const resp = await fetch(jwksUrl);
    if (!resp.ok) {
      diagnostics.steps.push({ step: 5, name: 'jwks_fetch', status: 'FAIL', detail: `HTTP ${resp.status}` });
      return c.json(diagnostics);
    }
    const jwks = await resp.json() as { keys: any[] };
    diagnostics.jwks_total_keys = jwks.keys.length;
    diagnostics.jwks_kids = jwks.keys.map((k: any) => ({ kid: k.kid, alg: k.alg, kty: k.kty, use: k.use }));

    signingKey = jwks.keys.find((k: any) => k.kty === 'RSA' && k.use === 'sig' && k.alg === 'RS256') || null;
    if (!signingKey) {
      diagnostics.steps.push({ step: 5, name: 'jwks_key_match', status: 'FAIL', detail: 'No RS256 signing key found' });
      return c.json(diagnostics);
    }
    diagnostics.jwks_selected_kid = (signingKey as any).kid;
    diagnostics.jwt_header_kid = diagnostics.jwt_header?.kid;
    diagnostics.kid_match = diagnostics.jwt_header?.kid === (signingKey as any).kid;
    diagnostics.steps.push({
      step: 5, name: 'jwks_fetch', status: 'PASS',
      detail: `Found key kid=${(signingKey as any).kid}, JWT kid=${diagnostics.jwt_header?.kid}, match=${diagnostics.kid_match}`
    });
  } catch (e: any) {
    diagnostics.steps.push({ step: 5, name: 'jwks_fetch', status: 'FAIL', detail: e.message });
    return c.json(diagnostics);
  }

  // Step 6: Import key
  let publicKey: CryptoKey;
  try {
    publicKey = await crypto.subtle.importKey(
      'jwk',
      signingKey!,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
    diagnostics.steps.push({ step: 6, name: 'key_import', status: 'PASS', detail: 'CryptoKey imported successfully' });
  } catch (e: any) {
    diagnostics.steps.push({ step: 6, name: 'key_import', status: 'FAIL', detail: e.message });
    return c.json(diagnostics);
  }

  // Step 7: Verify signature
  try {
    const signedContent = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    // base64url decode signature
    let sigB64 = parts[2].replace(/-/g, '+').replace(/_/g, '/');
    while (sigB64.length % 4 !== 0) sigB64 += '=';
    const sigBinary = atob(sigB64);
    const sigBytes = new Uint8Array(sigBinary.length);
    for (let i = 0; i < sigBinary.length; i++) sigBytes[i] = sigBinary.charCodeAt(i);

    const isValid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      sigBytes,
      signedContent
    );
    diagnostics.steps.push({ step: 7, name: 'signature_verify', status: isValid ? 'PASS' : 'FAIL', detail: `crypto.subtle.verify returned ${isValid}` });
    diagnostics.final_verdict = isValid ? 'TOKEN VALID' : 'SIGNATURE MISMATCH';
  } catch (e: any) {
    diagnostics.steps.push({ step: 7, name: 'signature_verify', status: 'FAIL', detail: e.message });
    diagnostics.final_verdict = 'SIGNATURE VERIFICATION ERROR';
  }

  return c.json(diagnostics, 200);
});
// --- END TEMPORARY DIAGNOSTIC ENDPOINT ---

// Mount route modules
app.route('/api/checkout', checkout);
app.route('/api/billing-portal', billing);
app.route('/api/enterprise', enterprise);
app.route('/api/referral', referral);
app.route('/api/affiliate', affiliate);
app.route('/api/tenants', tenants);

// 404 fallback
app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

// Global error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err.message);
  return c.json({ error: 'Internal server error' }, 500);
});

export default app;
