export default function SecurityPolicyDecisionBadge({ decision }) {
  const label = decision ? decision.replaceAll("_", " ") : "pending";
  const tone = decision === "blocked" ? "blocked" : decision === "requires_approval" ? "warning" : decision ? "allowed" : "pending";

  return (
    <span className={`status-pill policy-${tone}`} title={decision ? `Persisted security policy decision: ${label}.` : undefined}>
      {label}
    </span>
  );
}
