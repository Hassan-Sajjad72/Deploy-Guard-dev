export default function SecurityPolicyDecisionBadge({ decision }) {
  const label = decision || "pending";

  return (
    <span className={`status-pill policy-${label}`}>
      {label.replaceAll("_", " ")}
    </span>
  );
}
