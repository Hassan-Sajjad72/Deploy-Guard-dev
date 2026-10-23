export default function DeveloperDetailsAccordion({ details }) {
  if (!details || !Object.keys(details).length) return null;
  return <details className="developer-details-accordion"><summary>Other technical details</summary><dl>{Object.entries(details).filter(([, value]) => value !== null && value !== undefined && typeof value !== "object").map(([key, value]) => <div key={key}><dt>{key.replaceAll(/([A-Z])/g, " $1").replaceAll("_", " ")}</dt><dd>{String(value)}</dd></div>)}</dl></details>;
}
