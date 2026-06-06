# Structure API

Backend API for The Structure SaaS platform, deployed as a Cloudflare Worker.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| POST | `/api/checkout` | Create Stripe Checkout session |
| POST | `/api/billing-portal` | Create Stripe Customer Portal session |
| POST | `/api/enterprise` | Submit enterprise inquiry |

## Architecture

- **Runtime:** Cloudflare Workers
- **Framework:** Hono
- **Payments:** Stripe SDK
- **Auth:** Clerk (frontend) + Stripe Customer ID mapping

## Secrets

Set via `wrangler secret put <KEY>`:

- `STRIPE_SECRET_KEY` - Stripe secret API key
- `STRIPE_PRICE_ID` - Standard plan price ID ($900 AUD/mo)
- `STRIPE_COUPON_ID` - Partner 40% discount coupon ID
- `ALLOWED_ORIGINS` - Comma-separated CORS origins

## Development

```bash
npm install
npm run dev
```

## Deployment

```bash
npm run deploy
```

## License

Proprietary - Optimising Performance Pty Ltd
