# Organization entitlements

Existing Free, Pro and Pro Plus prices and default project quotas remain in place. Startup, team and agency workspaces can receive explicit operator-approved versions for members, current projects, project environments, active agency clients, evidence retention and daily AI request/spending budgets.

Only a billing operator or super administrator with a recently verified administrator password may publish a version. Every change requires a reason and an idempotency UUID. Versions and capacity metering events are immutable. The `/admin/entitlements` page records and reviews these changes; workspace owners and administrators can review capacity and history at `/workspaces/:organizationId/entitlements`.

Absent member, environment or client limits are disclosed as unconfigured. They do not mean unlimited capacity. Absent project overrides preserve the subscription's existing project quota. Absent AI overrides preserve the initial per-organization safety budgets of at most 100 requests and USD 5 tracked spending per UTC day, subject to any lower configured limit. Inference still requires current model-specific pricing evidence.

Reviewed AI increases also require server safety ceilings:

- `AI_HARD_ORGANIZATION_DAILY_REQUEST_LIMIT` defaults to `100`.
- `AI_HARD_ORGANIZATION_DAILY_BUDGET_USD` defaults to `5`.

Changing these ceilings alone does not grant a larger entitlement. A new explicitly approved version is required. Lowering a safety ceiling constrains subsequent requests even when a previously approved version is higher. Changing limits preserves previous versions, invoices, usage records and AWS resources. An organization already over a newly lowered limit retains its existing records but cannot add capacity beyond the limit.

Operational evidence retention cannot be configured below 90 days. This setting is a minimum retention commitment; it does not automatically delete evidence at expiry. No new evidence-deletion job is introduced.

Apply migration `1791676810000-OrganizationEntitlementVersions` before starting the updated API. Resource creation paths count authoritative organization-owned records while holding the entitlement advisory lock. Project environments count distinct project/environment pairs, including configured projects and retained route records, with archived projects excluded. Capacity events use idempotent identities and are retained independently of operational record deletion.
