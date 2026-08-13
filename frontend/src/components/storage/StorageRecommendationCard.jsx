export default function StorageRecommendationCard({ recommendation }) {
  return (
    <section className="panel">
      <h2>Recommendation</h2>
      <dl className="details-list">
        <dt>Required</dt>
        <dd>{recommendation?.required ? "Yes" : "No"}</dd>
        <dt>Recommended</dt>
        <dd>{recommendation?.recommended ? "Yes" : "No"}</dd>
        <dt>Enabled</dt>
        <dd>{recommendation?.enabled ? "Yes" : "No"}</dd>
      </dl>
      <ul className="checklist">
        {(recommendation?.reasons || []).map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
    </section>
  );
}
