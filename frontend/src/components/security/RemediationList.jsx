export default function RemediationList({ findings }) {
  const remediations = findings
    .filter((finding) => finding.remediation)
    .slice(0, 5);

  return (
    <section className="panel">
      <h2>Remediation</h2>
      {remediations.length === 0 ? (
        <p className="muted">No remediation guidance is available.</p>
      ) : (
        <ul className="remediation-list">
          {remediations.map((finding) => (
            <li key={finding.id}>
              <strong>{finding.vulnerabilityId}</strong>
              <span>{finding.remediation}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
