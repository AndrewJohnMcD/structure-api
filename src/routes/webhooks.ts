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
 *   - checkout.session.completed  -> record customer, write metadata
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
        await handleCheckoutCompleted(stripe, event);
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
 *   3. The Customer object becomes the single source of truth
 */
async function handleCheckoutCompleted(
  stripe: Stripe,
  event: Stripe.Event
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

  // Write metadata to the Stripe Customer object.
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
    // Don\'t throw -- we still want to return 200 to Stripe
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
