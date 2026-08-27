import { useState } from "react";
import AuditLogDetails from "./AuditLogDetails.jsx";
import { Button, DataTable, DetailsDrawer, StatusChip } from "../common/DesignSystem.jsx";

function date(value) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Unavailable";
}

function label(value) {
  return value ? String(value).replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : "Unavailable";
}

function summary(log) {
  if (log.status === "failed") return "Recorded failure";
  if (["warning", "blocked", "cancelled", "pending"].includes(log.status)) return "Recorded attention";
  return "Recorded activity";
}

export default function AuditLogsTable({ logs }) {
  const [selected, setSelected] = useState(null);
  return <>
    <DataTable caption="Sanitized administrative and product audit records" className="admin-responsive-table audit-table" label="Audit log table">
      <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Resource</th><th>Result</th><th>Source</th></tr></thead>
      <tbody>{logs.map((log) => <tr key={log.id}>
        <td data-label="Time" title={log.createdAt || "Unavailable"}>{date(log.createdAt)}</td>
        <td data-label="Actor"><strong title={log.actorEmail || "System"}>{log.actorEmail || "System"}</strong><span className="admin-cell-detail">{label(log.actorRole || "system")}</span></td>
        <td data-label="Action"><strong>{label(log.action)}</strong><span className="admin-cell-detail">{summary(log)}</span><Button onClick={() => setSelected(log)} tone="ghost">Details</Button></td>
        <td data-label="Resource"><strong>{label(log.resourceType)}</strong><span className="admin-cell-detail" title={log.resourceId || "No resource identifier"}>{log.resourceId || "No resource identifier"}</span></td>
        <td data-label="Result"><StatusChip status={log.status} /></td>
        <td data-label="Source">Audit log</td>
      </tr>)}</tbody>
    </DataTable>
    {selected ? <DetailsDrawer labelledBy="audit-record-details" onClose={() => setSelected(null)} title="Audit record details">
      <div className="audit-details-grid"><article><span>Time</span><strong>{date(selected.createdAt)}</strong></article><article><span>Actor</span><strong>{selected.actorEmail || "System"}</strong></article><article><span>Action</span><strong>{label(selected.action)}</strong></article><article><span>Resource</span><strong>{label(selected.resourceType)}</strong></article><article><span>Result</span><StatusChip status={selected.status} /></article><article><span>Source</span><strong>Audit log</strong></article></div>
      <section className="audit-details-evidence"><p className="eyebrow">Sanitized technical evidence</p><AuditLogDetails metadata={selected.metadata} /></section>
    </DetailsDrawer> : null}
  </>;
}
