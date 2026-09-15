# Stripe test-mode billing

DeployGuard uses Stripe-hosted Checkout and Stripe Billing in test mode. Stripe is
authoritative for paid subscription status, billing periods and renewal invoices;
DeployGuard remains authoritative for internal FREE access, quotas and the local
projection of those signed lifecycle events.

Configure `backend/.env` with Stripe test credentials:

```dotenv
BILLING_PROVIDER=stripe
BILLING_MODE=test
# Prefer a least-privilege Stripe test restricted key (rk_test_...).
STRIPE_SECRET_KEY=rk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRO_PRICE_ID=price_...
STRIPE_PRO_PLUS_PRICE_ID=price_...
```

For local webhook delivery, install the Stripe CLI and run:

```sh
stripe login
stripe listen --forward-to http://localhost:5000/api/billing/webhook/stripe
```

Copy the `whsec_...` signing secret printed by `stripe listen` into `STRIPE_WEBHOOK_SECRET`, then restart the backend. The CLI forwards Stripe test events directly to localhost, so no public callback tunnel is required.

Returning from Checkout never activates a plan. A verified webhook reconciles the
Stripe Customer, Subscription, configured recurring Price, billing period and
status before DeployGuard changes effective entitlements. Renewal invoices are
recorded from `invoice.paid`; failed invoices and subscription cancellation are
reflected from their authoritative Stripe lifecycle events.

Configure Stripe Billing Portal in the sandbox Dashboard before using **Manage
Billing**. DeployGuard creates a short-lived Portal Session for the authenticated
account's persisted Stripe Customer and never accepts a customer ID from the UI.
