import { Hono } from 'hono';
import { Env } from '../types';

const support = new Hono<{ Bindings: Env }>();

/**
 * POST /api/support
 * Receives support ticket submissions from authenticated portal users.
 * Delivers formatted ticket to business inbox via Resend.
 */
support.post('/', async (c) => {
  const body = await c.req.json<{
    subject: string;
    priority: string;
    message: string;
    userEmail?: string;
    userName?: string;
  }>();

  // Validate required fields
  if (!body.subject?.trim() || !body.priority?.trim() || !body.message?.trim()) {
    return c.json({ error: 'Subject, priority, and message are required' }, 400);
  }

  if (body.message.length > 5000) {
    return c.json({ error: 'Message must be 5000 characters or fewer' }, 422);
  }

  const validPriorities = ['low', 'medium', 'high', 'critical'];
  if (!validPriorities.includes(body.priority.toLowerCase())) {
    return c.json({ error: 'Invalid priority level' }, 422);
  }

  const priorityLabels: Record<string, string> = {
    low: 'Low (General Inquiry)',
    medium: 'Medium (Configuration Issue)',
    high: 'High (Performance Degradation)',
    critical: 'CRITICAL (Instance Down)',
  };

  const priorityColors: Record<string, string> = {
    low: '#4a9eff',
    medium: '#ffaa00',
    high: '#ff6b35',
    critical: '#ff3333',
  };

  const priority = body.priority.toLowerCase();

  // Build HTML email body
  const htmlBody = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; background: #0a0a0a; color: #e0e0e0; padding: 32px; border: 1px solid #1a3a5c;">
  <h1 style="color: #4a9eff; font-size: 20px; margin-bottom: 24px; border-bottom: 1px solid #1a3a5c; padding-bottom: 12px;">Support Ticket</h1>
  <table style="width: 100%; border-collapse: collapse;">
    <tr style="border-bottom: 1px solid #1a3a5c;">
      <td style="padding: 10px 0; color: #888; width: 120px;">Priority</td>
      <td style="padding: 10px 0; color: ${priorityColors[priority]}; font-weight: 600;">${priorityLabels[priority] || priority}</td>
    </tr>
    <tr style="border-bottom: 1px solid #1a3a5c;">
      <td style="padding: 10px 0; color: #888;">Subject</td>
      <td style="padding: 10px 0; color: #fff;">${body.subject}</td>
    </tr>
    ${body.userName ? `<tr style="border-bottom: 1px solid #1a3a5c;"><td style="padding: 10px 0; color: #888;">User</td><td style="padding: 10px 0; color: #fff;">${body.userName}</td></tr>` : ''}
    ${body.userEmail ? `<tr style="border-bottom: 1px solid #1a3a5c;"><td style="padding: 10px 0; color: #888;">Email</td><td style="padding: 10px 0;"><a href="mailto:${body.userEmail}" style="color: #4a9eff;">${body.userEmail}</a></td></tr>` : ''}
  </table>
  <div style="margin-top: 20px; padding: 16px; background: #111; border: 1px solid #1a3a5c; border-radius: 4px;">
    <p style="color: #888; margin: 0 0 8px 0; font-size: 13px;">Message</p>
    <p style="color: #fff; margin: 0; line-height: 1.6; white-space: pre-wrap;">${body.message}</p>
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
        reply_to: body.userEmail || undefined,
        subject: `[${priority.toUpperCase()}] Support: ${body.subject}`,
        html: htmlBody,
      }),
    });

    if (!resendResponse.ok) {
      const errorData = await resendResponse.text();
      console.error('Resend API error:', resendResponse.status, errorData);
      return c.json({ error: 'Failed to submit ticket. Please try again.' }, 502);
    }

    const result = await resendResponse.json();
    console.log('Support ticket delivered:', {
      resendId: (result as Record<string, unknown>).id,
      priority,
      subject: body.subject,
      timestamp: new Date().toISOString(),
    });

    return c.json({
      success: true,
      message: 'Your support ticket has been submitted. We will respond within 24 hours.',
    });
  } catch (err) {
    console.error('Resend delivery failed:', err);
    return c.json({ error: 'Failed to submit ticket. Please try again.' }, 502);
  }
});

export { support };
