import { Hono } from 'hono';
import Stripe from 'stripe';
import { Env } from '../types';

const webhooks = new Hono<{ Bindings: Env }>();

/**
 * POST /api/webhooks/stripe
 *
 * Stripe webhook listener. Verifies the request signature using the
 * STRIPE_WEBHOOK_SECRET, then dispatches to event-specific handlers.
 *
 * This route does NOT use CORS or admin auth middleware.
 * Stripe calls it server-to-server with a signed payload.
 *
 * Handled events:
 *   - checkout.session.completed  -> record customer, write metadata, send Clerk invitation, create affiliate
 *   - invoice.paid                -> log successful payment
 *   - invoice.payment_failed      -> log failed payment for alerting
 *   - customer.subscription.updated -> log plan changes
 *   - customer.subscription.deleted -> log cancellation for cleanup
 *   - charge.dispute.created      -> log chargeback alert
 */
webhooks.post('/', async (c) => {
  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);

  // --- 1. Verify Stripe signature ---
  const signature = c.req.header('stripe-signature');
  if (!signature) {
    console.error('Webhook: missing stripe-signature header');
    return c.json({ error: 'Missing signature' }, 400);
  }

  if (!c.env.STRIPE_WEBHOOK_SECRET) {
    console.error('Webhook: STRIPE_WEBHOOK_SECRET not configured');
    return c.json({ error: 'Webhook secret not configured' }, 500);
  }

  // Stripe SDK requires the raw body string for signature verification
  const rawBody = await c.req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      c.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Webhook signature verification failed:', message);
    return c.json({ error: 'Invalid signature' }, 400);
  }

  // --- 2. Dispatch by event type ---
  console.log(`Webhook received: ${event.type} [${event.id}]`);

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(stripe, event, c.env);
        break;

      case 'invoice.paid':
        handleInvoicePaid(event);
        break;

      case 'invoice.payment_failed':
        handleInvoicePaymentFailed(event);
        break;

      case 'customer.subscription.updated':
        handleSubscriptionUpdated(event);
        break;

      case 'customer.subscription.deleted':
        handleSubscriptionDeleted(event);
        break;

      case 'charge.dispute.created':
        handleDisputeCreated(event);
        break;

      default:
        // Unhandled event types are acknowledged silently.
        // This prevents Stripe from retrying events we don\'t care about.
        console.log(`Webhook: unhandled event type ${event.type}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`Webhook handler error for ${event.type}:`, message);
    // Return 200 even on handler errors to prevent Stripe retries.
    // The error is logged for investigation.
  }

  // Always return 200 to acknowledge receipt.
  // Stripe retries on non-2xx responses, which we want to avoid.
  return c.json({ received: true });
});

// ============================================================
// Event Handlers
// ============================================================

/**
 * checkout.session.completed
 *
 * Fired when a customer completes payment. This is the critical event
 * that converts a visitor into a paying customer.
 *
 * Actions:
 *   1. Extract customer ID, subscription ID, and referral code
 *   2. Write metadata back to the Stripe Customer object
 *   3. Send a Clerk invitation email so the customer can create their Portal account
 *   4. Create a FirstPromoter affiliate record for viral referral distribution
 */
async function handleCheckoutCompleted(
  stripe: Stripe,
  event: Stripe.Event,
  env: Env
): Promise<void> {
  const session = event.data.object as Stripe.Checkout.Session;

  const customerId = session.customer as string;
  const subscriptionId = session.subscription as string;
  const customerEmail = session.customer_details?.email || '';
  const referralCode = session.metadata?.referralCode || '';

  console.log(
    `CHECKOUT COMPLETED: customer=${customerId}, ` +
    `subscription=${subscriptionId}, ` +
    `email=${customerEmail}, ` +
    `referral=${referralCode || 'none'}`
  );

  // --- Step 1: Write metadata to the Stripe Customer object ---
  // This makes the Customer the single source of truth for:
  //   - subscription status (queryable via Stripe API)
  //   - referral attribution (for FirstPromoter reconciliation)
  //   - region preference (set later via post-purchase onboarding)
  //   - provisioning status (updated when Droplet is created)
  try {
    await stripe.customers.update(customerId, {
      metadata: {
        subscriptionId,
        referralCode,
        provisioningStatus: 'awaiting_region_selection',
        signupDate: new Date().toISOString(),
      },
    });
    console.log(`Customer ${customerId} metadata updated successfully`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`Failed to update customer ${customerId} metadata:`, message);
    // Don\'t throw -- we still want to send the invitation
  }

  // --- Step 2: Send Clerk invitation email ---
  // This creates an invitation in the Portal Clerk instance.
  // The customer receives an email with a link to create their account.
  // Once they sign in, the Portal detects their Stripe subscription
  // and presents the region selection onboarding flow.
  if (!customerEmail) {
    console.error('CHECKOUT: No customer email found -- cannot send Clerk invitation');
    return;
  }

  if (!env.CLERK_SECRET_KEY) {
    console.error('CHECKOUT: CLERK_SECRET_KEY not configured -- cannot send invitation');
    return;
  }

  try {
    const invitationResponse = await fetch('https://api.clerk.com/v1/invitations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.CLERK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email_address: customerEmail,
        redirect_url: 'https://portal.optimisingperformance.com.au/sign-up',
        notify: true,
        ignore_existing: true,
      }),
    });

    if (invitationResponse.ok) {
      const invitationData = await invitationResponse.json() as Record<string, unknown>;
      console.log(
        `CLERK INVITATION SENT: email=${customerEmail}, ` +
        `invitation_id=${invitationData.id || 'unknown'}`
      );
    } else {
      const errorBody = await invitationResponse.text();
      console.error(
        `CLERK INVITATION FAILED: status=${invitationResponse.status}, ` +
        `email=${customerEmail}, ` +
        `response=${errorBody}`
      );
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`CLERK INVITATION ERROR: email=${customerEmail}, error=${message}`);
    // Don\'t throw -- the payment is already processed.
    // The invitation failure is logged for manual follow-up.
  }

  // --- Step 3: Create FirstPromoter affiliate record ---
  // Every paying customer automatically becomes an affiliate with their own
  // referral code, enabling viral distribution from day one.
  // This block is fail-open: FirstPromoter failures never block onboarding.
  try {
    if (!env.FIRSTPROMOTER_API_KEY) {
      console.warn('CHECKOUT: FIRSTPROMOTER_API_KEY not configured -- skipping affiliate creation');
    } else {
      // 3a. If the customer used a referral code, resolve the parent promoter ID
      //     so the new affiliate is linked under the referring partner's tree.
      let parentPromoterId: string | null = null;

      if (referralCode) {
        try {
          const parentRes = await fetch(
            `https://firstpromoter.com/api/v1/promoters/list?ref_id=${encodeURIComponent(referralCode)}`,
            {
              headers: {
                'x-api-key': env.FIRSTPROMOTER_API_KEY,
                'Content-Type': 'application/json',
              },
            }
          );

          if (parentRes.ok) {
            const parents = await parentRes.json() as Array<{ id: number; default_ref_id: string }>;
            const match = parents.find((p) => p.default_ref_id === referralCode);
            if (match) {
              parentPromoterId = String(match.id);
              console.log(`FIRSTPROMOTER: Resolved parent promoter ID=${parentPromoterId} for ref_id=${referralCode}`);
            }
          }
        } catch (parentErr: unknown) {
          const msg = parentErr instanceof Error ? parentErr.message : 'Unknown error';
          console.warn(`FIRSTPROMOTER: Parent lookup failed for ref_id=${referralCode}: ${msg}`);
          // Continue without parent -- customer still becomes a standalone Tier 1 affiliate
        }
      }

      // 3b. Create the new promoter via FirstPromoter v1 API
      //     CRITICAL: v1 API requires application/x-www-form-urlencoded, NOT JSON.
      const customerName = session.customer_details?.name || '';
      const formParams = new URLSearchParams();
      formParams.append('email', customerEmail);
      if (customerName) formParams.append('first_name', customerName);
      if (parentPromoterId) formParams.append('parent_promoter_id', parentPromoterId);

      const createRes = await fetch('https://firstpromoter.com/api/v1/promoters/create', {
        method: 'POST',
        headers: {
          'x-api-key': env.FIRSTPROMOTER_API_KEY,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formParams.toString(),
      });

      if (createRes.ok) {
        const newPromoter = await createRes.json() as Record<string, unknown>;
        console.log(
          `FIRSTPROMOTER AFFILIATE CREATED: email=${customerEmail}, ` +
          `promoter_id=${newPromoter.id || 'unknown'}, ` +
          `ref_id=${(newPromoter as Record<string, unknown>).default_ref_id || 'pending'}` +
          (parentPromoterId ? `, parent=${parentPromoterId}` : ', tier=1 (standalone)')
        );
      } else if (createRes.status === 422) {
        // Idempotency guard: promoter already exists for this email.
        // This handles Stripe webhook retries gracefully.
        console.log(`FIRSTPROMOTER: Promoter already exists for ${customerEmail} (idempotent, safe to ignore)`);
      } else {
        const errorBody = await createRes.text();
        console.error(
          `FIRSTPROMOTER CREATE FAILED: status=${createRes.status}, ` +
          `email=${customerEmail}, response=${errorBody}`
        );
      }
    }
  } catch (fpErr: unknown) {
    const message = fpErr instanceof Error ? fpErr.message : 'Unknown error';
    console.error(`FIRSTPROMOTER ERROR: email=${customerEmail}, error=${message}`);
    // Fail-open: FirstPromoter failure never blocks customer onboarding.
    // The affiliate record can be created manually if needed.
  }
}

/**
 * invoice.paid
 *
 * Fired on every successful payment, including the initial charge
 * and all recurring subscription renewals.
 */
function handleInvoicePaid(event: Stripe.Event): void {
  const invoice = event.data.object as Stripe.Invoice;
  const customerId = invoice.customer as string;
  const amount = invoice.amount_paid;
  const currency = invoice.currency;

  console.log(
    `INVOICE PAID: customer=${customerId}, ` +
    `amount=${amount} ${currency.toUpperCase()}, ` +
    `invoice=${invoice.id}`
  );
}

/**
 * invoice.payment_failed
 *
 * Fired when a recurring payment fails. This is a critical alert --
 * the customer\'s access should be reviewed if payment cannot be recovered.
 */
function handleInvoicePaymentFailed(event: Stripe.Event): void {
  const invoice = event.data.object as Stripe.Invoice;
  const customerId = invoice.customer as string;
  const attemptCount = invoice.attempt_count;

  console.error(
    `PAYMENT FAILED: customer=${customerId}, ` +
    `attempt=${attemptCount}, ` +
    `invoice=${invoice.id} ` +
    `-- ACTION REQUIRED: review customer access`
  );
}

/**
 * customer.subscription.updated
 *
 * Fired when a subscription changes state (e.g., active -> past_due,
 * plan upgrade/downgrade, trial ending).
 */
function handleSubscriptionUpdated(event: Stripe.Event): void {
  const subscription = event.data.object as Stripe.Subscription;
  const customerId = subscription.customer as string;
  const status = subscription.status;

  console.log(
    `SUBSCRIPTION UPDATED: customer=${customerId}, ` +
    `status=${status}, ` +
    `subscription=${subscription.id}`
  );
}

/**
 * customer.subscription.deleted
 *
 * Fired when a subscription is cancelled and fully terminated.
 * The customer\'s Droplet should be flagged for deprovisioning.
 */
function handleSubscriptionDeleted(event: Stripe.Event): void {
  const subscription = event.data.object as Stripe.Subscription;
  const customerId = subscription.customer as string;

  console.error(
    `SUBSCRIPTION DELETED: customer=${customerId}, ` +
    `subscription=${subscription.id} ` +
    `-- ACTION REQUIRED: flag Droplet for deprovisioning`
  );
}

/**
 * charge.dispute.created
 *
 * Fired when a customer initiates a chargeback. This is a high-priority
 * alert requiring immediate investigation.
 */
function handleDisputeCreated(event: Stripe.Event): void {
  const dispute = event.data.object as Stripe.Dispute;
  const chargeId = dispute.charge as string;
  const amount = dispute.amount;
  const reason = dispute.reason;

  console.error(
    `DISPUTE CREATED: charge=${chargeId}, ` +
    `amount=${amount}, ` +
    `reason=${reason} ` +
    `-- URGENT: respond within deadline`
  );
}

export { webhooks };
