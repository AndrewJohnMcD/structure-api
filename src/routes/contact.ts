import { Hono } from 'hono';
import { Env } from '../types';

const contact = new Hono<{ Bindings: Env }>();

/**
 * POST /api/contact
 * Lightweight contact form - no enterprise restrictions.
 * Accepts any email address (personal or corporate).
 * Delivers formatted message to business inbox via Resend.
 */
contact.post('/', async (c) => {
  const body = await c.req.json<{
    name: string;
    email: string;
    message: string;
  }>();

  // Validate required fields
  if (!body.name?.trim()) {
    return c.json({ error: 'Name is required' }, 400);
  }
  if (!body.email?.trim()) {
    return c.json({ error: 'Email is required' }, 400);
  }
  // Basic email format check
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) {
    return c.json({ error: 'Please enter a valid email address' }, 422);
  }
  if (!body.message?.trim()) {
    return c.json({ error: 'Message is required' }, 400);
  }
  if (body.message.length > 1000) {
    return c.json({ error: 'Message must be 1000 characters or fewer' }, 422);
  }

  // Build HTML email body
  const htmlBody = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; background: #0a0a0a; color: #e0e0e0; padding: 32px; border: 1px solid #1a3a5c;">
  <h1 style="color: #4a9eff; font-size: 20px; margin-bottom: 24px; border-bottom: 1px solid #1a3a5c; padding-bottom: 12px;">New Contact Message</h1>
  <table style="width: 100%; border-collapse: collapse;">
    <tr style="border-bottom: 1px solid #1a3a5c;">
      <td style="padding: 10px 0; color: #888; width: 120px;">Name</td>
      <td style="padding: 10px 0; color: #fff;">${body.name}</td>
    </tr>
    <tr style="border-bottom: 1px solid #1a3a5c;">
      <td style="padding: 10px 0; color: #888;">Email</td>
      <td style="padding: 10px 0;"><a href="mailto:${body.email}" style="color: #4a9eff;">${body.email}</a></td>
    </tr>
  </table>
  <div style="margin-top: 20px; padding: 16px; background: #111; border: 1px solid #1a3a5c; border-radius: 4px;">
    <p style="color: #888; margin: 0 0 8px 0; font-size: 13px;">Message</p>
    <p style="color: #fff; margin: 0; line-height: 1.6;">${body.message}</p>
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
        reply_to: body.email.trim(),
        subject: `Contact: ${body.name.trim()}`,
        html: htmlBody,
      }),
    });

    if (!resendResponse.ok) {
      const errorData = await resendResponse.text();
      console.error('Resend API error:', resendResponse.status, errorData);
      return c.json({ error: 'Failed to send message. Please try again.' }, 502);
    }

    const result = await resendResponse.json();
    console.log('Contact message delivered:', {
      resendId: (result as Record<string, unknown>).id,
      name: body.name,
      email: body.email,
      timestamp: new Date().toISOString(),
    });

    return c.json({
      success: true,
      message: 'Message received. We will be in touch soon.',
    });
  } catch (err) {
    console.error('Resend delivery failed:', err);
    return c.json({ error: 'Failed to send message. Please try again.' }, 502);
  }
});

export { contact };
