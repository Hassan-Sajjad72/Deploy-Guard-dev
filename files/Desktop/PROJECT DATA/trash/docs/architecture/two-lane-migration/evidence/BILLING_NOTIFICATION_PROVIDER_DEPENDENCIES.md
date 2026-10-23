# Billing and notification provider dependency record

Verified 2026-08-01 for P2-3.

Decision: Stripe billing and SNS delivery are deferred, non-blocking
productization work and are outside the current project scope. Both activation
gates remain `false`; no further provider configuration or testing is planned
for core deployment closure.

## Local durable evidence

- Stripe and SNS adapters are protected by separate exact-`true` gates:
  `BILLING_PROVIDER_ENABLED` and `NOTIFICATION_DELIVERY_ENABLED`. Both default
  to `false`.
- A 60-migration disposable PostgreSQL database proved one concurrent Stripe
  event is processed once, the duplicate returns the persisted result, and an
  older subscription event cannot replace newer entitlement evidence.
- The same fixture proved one notification delivery row, bounded retry to the
  third attempt, one metering effect, duplicate-delivery reuse, sanitized
  metadata, and enforced Free-plan rejection beyond the Terraform-export
  limit.
- `test:billing` and `test:notifications` prove disabled providers cannot be
  reached even when provider identifiers are present in configuration.

No provider endpoint was called. The fixture adapter existed only inside the
verification process and reported `externalProviders: not_invoked`.

## External dependencies not available

The local backend configuration contained no Stripe secret key, price ID or
webhook secret, and no SNS topic ARN. Therefore checkout, portal, signed
webhook forwarding, SNS subscription confirmation and email delivery were not
claimed. Controlled provider verification requires operator-owned Stripe test
credentials and an exact SNS topic/IAM/destination configuration; only then
may the corresponding exact gate be enabled for the bounded backend process.

Live AWS evidence: not used. Stripe evidence: not used. Operational DeployGuard
records were not used or changed.
