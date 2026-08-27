import { useProductMode } from "../../hooks/useProductMode.js";

export default function DeveloperDetailsAccordion({ details }) {
  const { isDeveloperMode } = useProductMode();
  if (!isDeveloperMode || !details || !Object.keys(details).length) return null;
  const stripSensitive = (value) => {
    if (Array.isArray(value)) return value.map(stripSensitive);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !/secret|password|token|credential|cookie|authorization|environmentvalue/i.test(key)).map(([key, nested]) => [key, stripSensitive(nested)]));
  };
  const visible = Object.entries(details).filter(([key, value]) => value !== null && value !== undefined && !/secret|password|token|credential|cookie|authorization|environmentvalue/i.test(key)).map(([key, value]) => [key, stripSensitive(value)]);
  return <details className="developer-details-accordion"><summary>Other technical details</summary><dl>{visible.map(([key, value]) => <div key={key}><dt>{key.replaceAll(/([A-Z])/g, " $1").replaceAll("_", " ")}</dt><dd>{typeof value === "object" ? <code>{JSON.stringify(value, null, 2)}</code> : String(value)}</dd></div>)}</dl></details>;
}
