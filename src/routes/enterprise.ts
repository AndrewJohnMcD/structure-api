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
 * Delivers formatted inquiry to business inbox via Resend.
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

  // Build HTML email body
  const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; background: #0a0a0a; color: #e0e0e0; padding: 32px; border: 1px solid #1a3a5c;">
      <h1 style="color: #4a9eff; font-size: 20px; margin-bottom: 24px; border-bottom: 1px solid #1a3a5c; padding-bottom: 12px;">Enterprise Inquiry</h1>
      <table style="width: 100%; border-collapse: collapse;">
        <tr style="border-bottom: 1px solid #1a3a5c;">
          <td style="padding: 10px 0; color: #888; width: 120px;">Name</td>
          <td style="padding: 10px 0; color: #fff;">${body.name}</td>
        </tr>
        <tr style="border-bottom: 1px solid #1a3a5c;">
          <td style="padding: 10px 0; color: #888;">Email</td>
          <td style="padding: 10px 0;"><a href="mailto:${body.email}" style="color: #4a9eff;">${body.email}</a></td>
        </tr>
        <tr style="border-bottom: 1px solid #1a3a5c;">
          <td style="padding: 10px 0; color: #888;">Company</td>
          <td style="padding: 10px 0; color: #fff;">${body.company}</td>
        </tr>
        <tr style="border-bottom: 1px solid #1a3a5c;">
          <td style="padding: 10px 0; color: #888;">Job Title</td>
          <td style="padding: 10px 0; color: #fff;">${body.jobTitle}</td>
        </tr>
        <tr style="border-bottom: 1px solid #1a3a5c;">
          <td style="padding: 10px 0; color: #888;">Company Size</td>
          <td style="padding: 10px 0; color: #fff;">${body.size}</td>
        </tr>
        <tr style="border-bottom: 1px solid #1a3a5c;">
          <td style="padding: 10px 0; color: #888;">Website</td>
          <td style="padding: 10px 0;"><a href="${body.website}" style="color: #4a9eff;">${body.website}</a></td>
        </tr>
      </table>
      <div style="margin-top: 20px; padding: 16px; background: #111; border: 1px solid #1a3a5c; border-radius: 4px;">
        <p style="color: #888; margin: 0 0 8px 0; font-size: 13px;">Use Case</p>
        <p style="color: #fff; margin: 0; line-height: 1.6;">${body.useCase}</p>
      </div>
      <p style="color: #555; font-size: 11px; margin-top: 24px; text-align: center;">Submitted ${new Date().toISOString()}</p>
    </div>
  `;

  // Send via Resend API
  try {
    const resendResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${c.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'The Structure <noreply@mail.optimisingperformance.com.au>',
        to: ['optimism@optimisingperformance.com.au'],
        reply_to: body.email,
        subject: `Enterprise Inquiry: ${body.company} - ${body.name}`,
        html: htmlBody,
      }),
    });

    if (!resendResponse.ok) {
      const errorData = await resendResponse.text();
      console.error('Resend API error:', resendResponse.status, errorData);
      return c.json({ error: 'Failed to submit inquiry. Please try again.' }, 502);
    }

    const result = await resendResponse.json();
    console.log('Enterprise inquiry delivered:', {
      resendId: (result as Record<string, unknown>).id,
      company: body.company,
      email: body.email,
      timestamp: new Date().toISOString(),
    });

    return c.json({
      success: true,
      message: 'Your inquiry has been received. We respond within 48 hours.',
    });
  } catch (err) {
    console.error('Resend delivery failed:', err);
    return c.json({ error: 'Failed to submit inquiry. Please try again.' }, 502);
  }
});

export { enterprise };
