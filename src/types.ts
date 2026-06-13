export interface Env {
  STRIPE_SECRET_KEY: string;
  STRIPE_PRICE_ID: string;
  STRIPE_COUPON_ID: string;
  STRIPE_WEBHOOK_SECRET: string;
  FIRSTPROMOTER_API_KEY: string;
  FIRSTPROMOTER_ACCOUNT_ID: string;
  RESEND_API_KEY: string;
  DO_API_TOKEN: string;
  CLERK_JWKS_URL: string;
  CLERK_CUSTOMER_JWKS_URL: string;
  CLERK_SECRET_KEY: string;
  ALLOWED_ORIGINS: string;
  CF_API_TOKEN: string;
  CF_ZONE_ID: string;
  CF_ACCOUNT_ID: string;
}
