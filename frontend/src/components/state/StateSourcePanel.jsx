function format(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value).replaceAll("_", " ");
}

export default function StateSourcePanel({ snapshot }) {
  const rows = Object.entries(snapshot?.sources || {});
  if (!rows.length) return null;
  return <details className="panel developer-details-accordion">
    <summary>State decision sources</summary>
    <div className="table-wrap"><table><thead><tr><th>Field</th><th>Value</th><th>Source</th><th>Source timestamp</th><th>Winning value</th></tr></thead><tbody>{rows.map(([field, source]) => <tr key={field}><td>{format(field)}</td><td>{format(source.value)}</td><td>{source.source}</td><td>{source.sourceTimestamp ? new Date(source.sourceTimestamp).toLocaleString() : "—"}</td><td>{format(source.winningValue)}</td></tr>)}</tbody></table></div>
  </details>;
}
