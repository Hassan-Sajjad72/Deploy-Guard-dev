import { Fragment, useState } from "react";
import AuditLogDetails from "./AuditLogDetails.jsx";
import { StatusBadge, formatStatus } from "../common/Premium.jsx";

function formatDate(value) {
  if (!value) {
    return "-";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export default function AuditLogsTable({ logs }) {
  const [openLogId, setOpenLogId] = useState(null);

  return (
    <div className="table-wrap panel">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Resource</th>
            <th>Status</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((log) => (
            <Fragment key={log.id}>
              <tr>
                <td>{formatDate(log.createdAt)}</td>
                <td><strong>{log.actorEmail || "System"}</strong><br /><span className="muted">{formatStatus(log.actorRole || "system")}</span></td>
                <td><strong>{formatStatus(log.action)}</strong><br /><span className="muted">{activitySummary(log)}</span></td>
                <td>{formatStatus(log.resourceType)}<br /><span className="muted wrap-cell">{log.resourceId || "No resource ID"}</span></td>
                <td><StatusBadge status={log.status} /></td>
                <td>
                  <button
                    className="secondary-button"
                    onClick={() =>
                      setOpenLogId((current) =>
                        current === log.id ? null : log.id
                      )
                    }
                    type="button"
                  >
                    {openLogId === log.id ? "Close Details" : "View Details"}
                  </button>
                </td>
              </tr>
              {openLogId === log.id ? (
                <tr>
                  <td colSpan="6">
                    <AuditLogDetails metadata={log.metadata} />
                  </td>
                </tr>
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function activitySummary(log) {
  const resource = formatStatus(log.resourceType || "resource").toLowerCase();
  if (log.status === "failed") return `The ${resource} operation failed. Open details for sanitized diagnostic context.`;
  if (log.status === "success") return `The ${resource} operation completed successfully.`;
  return `The ${resource} operation recorded status ${formatStatus(log.status)}.`;
}
