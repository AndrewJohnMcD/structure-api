import { Hono } from 'hono';
import { Env } from '../types';

const enterprise = new Hono<{ Bindings: Env }>();

// Free email domains to reject (anti-spam)
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'aol.com', 'icloud.com', 'mail.com', 'protonmail.com',
  'zoho.com', 'yandex.com', 'gmx.com', 'live.com',
]);

/**
 * POST /api/enterprise
 * Receives enterprise contact form submissions with anti-spam validation.
 */
enterprise.post('/', async (c) => {
  const body = await c.req.json<{
    name: string;
    email: string;
    company: string;
    size: string;
    jobTitle: string;
    website: string;
    useCase: string;
  }>();

  // Validate required fields
  const required = ['name', 'email', 'company', 'size', 'jobTitle', 'website', 'useCase'] as const;
  for (const field of required) {
    if (!body[field] || body[field].trim().length === 0) {
      return c.json({ error: `Missing required field: ${field}` }, 400);
    }
  }

  // Anti-spam: reject free email domains
  const emailDomain = body.email.split('@')[1]?.toLowerCase();
  if (!emailDomain || FREE_EMAIL_DOMAINS.has(emailDomain)) {
    return c.json({ error: 'Please use your company email address' }, 422);
  }

  // Validate use case length
  if (body.useCase.length > 1000) {
    return c.json({ error: 'Use case must be 1000 characters or fewer' }, 422);
  }

  // Log the inquiry (in production: database or email service)
  console.log('Enterprise inquiry received:', {
    name: body.name,
    email: body.email,
    company: body.company,
    size: body.size,
    jobTitle: body.jobTitle,
    website: body.website,
    useCaseLength: body.useCase.length,
    timestamp: new Date().toISOString(),
  });

  return c.json({
    success: true,
    message: 'Your inquiry has been received. We respond within 48 hours.',
  });
});

export { enterprise };
