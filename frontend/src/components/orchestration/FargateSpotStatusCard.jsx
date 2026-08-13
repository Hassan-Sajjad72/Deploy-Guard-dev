export default function FargateSpotStatusCard({ scaling }) {
  const strategy = scaling?.capacityProviderStrategy || [];
  const spot = strategy.find((item) => item.capacity_provider === "FARGATE_SPOT");

  return (
    <section className="panel">
      <h2>Fargate Spot</h2>
      <dl className="details-list">
        <dt>Enabled</dt>
        <dd>{spot ? "Yes" : "No"}</dd>
        <dt>Strategy</dt>
        <dd>{strategy.length ? strategy.map((item) => `${item.capacity_provider}:${item.weight}`).join(", ") : "-"}</dd>
      </dl>
    </section>
  );
}
