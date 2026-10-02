import { useState } from "react";
import AuditLogDetails from "./AuditLogDetails.jsx";
import { Button, DataTable, DetailsDrawer, Status, statusTone } from "../common/DesignSystem.jsx";
import Time from "../common/Time.jsx";
import { formatDateTime } from "../../utils/time.js";

function label(value) {
  return value ? String(value).replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").replaceAll("-", " ").toLowerCase().replace(/^\w/, (letter) => letter.toUpperCase()) : "—";
}

export default function AuditLogsTable({ logs }) {
  const [selected, setSelected] = useState(null);
  return <>
    <DataTable caption="Sanitized administrative and product audit records" className="audit-table" label="Audit log">
      <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Resource</th><th>Result</th><th><span className="sr-only">Details</span></th></tr></thead>
      <tbody>{logs.map((log) => <tr data-status={log.status} key={log.id}>
        <td data-label="Time"><Time value={log.createdAt} /></td>
        <td data-label="Actor"><span title={log.actorEmail || "System"}>{log.actorEmail || "System"}</span><span className="cell-sub">{label(log.actorRole || "system")}</span></td>
        <td data-label="Action">{label(log.action)}</td>
        <td data-label="Resource">{label(log.resourceType)}<span className="cell-sub mono" title={log.resourceId || ""}>{log.resourceId ? String(log.resourceId).slice(0, 18) : "—"}</span></td>
        <td data-label="Result"><Status tone={statusTone(log.status)}>{label(log.status)}</Status></td>
        <td className="cell-end" data-label=""><Button onClick={() => setSelected(log)} size="sm" tone="ghost">Details</Button></td>
      </tr>)}</tbody>
    </DataTable>
    {selected ? <DetailsDrawer labelledBy="audit-record-details" onClose={() => setSelected(null)} title={label(selected.action)}>
      <Status tone={statusTone(selected.status)}>{label(selected.status)}</Status>
      <dl className="facts-list"><div><dt>Time</dt><dd>{formatDateTime(selected.createdAt)}</dd></div><div><dt>Actor</dt><dd>{selected.actorEmail || "System"} · {label(selected.actorRole || "system")}</dd></div><div><dt>Resource</dt><dd>{label(selected.resourceType)}</dd></div><div><dt>Resource ID</dt><dd className="mono">{selected.resourceId || "—"}</dd></div></dl>
      <section className="section"><div className="section-head"><h2>Recorded details</h2><p>Sensitive values are redacted.</p></div><AuditLogDetails metadata={selected.metadata} /></section>
    </DetailsDrawer> : null}
  </>;
}
