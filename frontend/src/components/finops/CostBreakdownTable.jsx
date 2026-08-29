import CostResourceTypeBadge from "./CostResourceTypeBadge.jsx";

function money(value, currency = "USD") {
  return new Intl.NumberFormat(undefined, {
    currency,
    style: "currency",
  }).format(Number(value || 0));
}

export default function CostBreakdownTable({ breakdowns = [], currency = "USD" }) {
  return (
    <section className="panel">
      <h2>Resource Breakdown</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Resource</th>
              <th>Service</th>
              <th>Monthly Cost</th>
            </tr>
          </thead>
          <tbody>
            {breakdowns.map((breakdown) => (
              <tr key={breakdown.id || breakdown.resourceName}>
                <td>
                  <CostResourceTypeBadge type={breakdown.resourceType} />
                </td>
                <td className="wrap-cell">{breakdown.resourceName}</td>
                <td>{breakdown.serviceName || "-"}</td>
                <td>{money(breakdown.monthlyCost, currency)}</td>
              </tr>
            ))}
            {breakdowns.length === 0 ? (
              <tr>
                <td colSpan="4">No resource breakdown rows available.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
