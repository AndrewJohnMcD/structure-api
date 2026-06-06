# Structure API

Backend API for The Structure SaaS platform, deployed as a Cloudflare Worker.

## Endpoints

### Health
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Service health check |

### Stripe (Phase A)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/checkout` | Create Stripe Checkout session with optional referral code |
| POST | `/api/billing-portal` | Create Stripe Customer Portal session |
| POST | `/api/enterprise` | Enterprise contact form with anti-spam validation |

### FirstPromoter (Phase B)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/referral/validate` | Validate a referral code against FirstPromoter |
| GET | `/api/affiliate/stats?email=` | Promoter dashboard stats |
| GET | `/api/affiliate/referrals?email=` | Promoter referral list |
| GET | `/api/affiliate/earnings?email=` | Promoter commission transactions |

## Secrets

All secrets are injected via `wrangler secret put <KEY>`:

- `STRIPE_SECRET_KEY` - Stripe secret key
- `STRIPE_PRICE_ID` - Standard plan price ID ($900 AUD/mo)
- `STRIPE_COUPON_ID` - 40% partner discount coupon
- `FIRSTPROMOTER_API_KEY` - FirstPromoter API key
- `FIRSTPROMOTER_ACCOUNT_ID` - FirstPromoter account ID
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
