function money(value, currency = "USD") {
  return new Intl.NumberFormat(undefined, {
    currency,
    style: "currency",
  }).format(Number(value || 0));
}

export default function CostPolicyBanner({ estimate }) {
  if (!estimate) {
    return null;
  }

  if (estimate.blockedByTierLimit) {
    return (
      <div className="state error">
        {estimate.upgradePromptMessage ||
          `Estimated cost exceeds the tier limit of ${money(
            estimate.tierLimitMonthlyCost,
            estimate.currency
          )}.`}
      </div>
    );
  }

  if (estimate.approvalRequired || estimate.status === "approval_required") {
    return (
      <div className="state">
        Estimated cost is above the warning threshold and requires approval.
      </div>
    );
  }

  if (estimate.status === "warning_over_tier") {
    return (
      <div className="state">
        Estimated cost is above the configured tier. Tier Enforcement Off; this
        warning does not block deployment.
      </div>
    );
  }

  if (estimate.status === "approved" || estimate.status === "no_approval_required") {
    return <div className="state success">Cost policy passed.</div>;
  }

  if (estimate.status === "rejected" || estimate.status === "failed") {
    return <div className="state error">{estimate.errorMessage || "Cost gate stopped."}</div>;
  }

  return null;
}
