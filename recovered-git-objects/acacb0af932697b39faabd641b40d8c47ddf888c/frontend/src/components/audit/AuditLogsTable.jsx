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
    <div aria-label="Audit log table" className="admin-table-wrap" tabIndex="0">
      <table className="admin-table audit-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Category</th>
            <th>Resource</th>
            <th>Project / Run ID</th>
            <th>Status</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((log) => (
            <Fragment key={log.id}>
              <tr>
                <td><span className="admin-value" title={log.createdAt || "Unavailable"}>{formatDate(log.createdAt)}</span></td>
                <td><strong className="admin-value" title={log.actorEmail || "System"}>{log.actorEmail || "System"}</strong><span className="muted admin-value">{formatStatus(log.actorRole || "system")}</span></td>
                <td><strong className="admin-value">{formatStatus(log.action)}</strong><span className="muted admin-value">{activitySummary(log)}</span></td>
                <td><span className="admin-value">{formatStatus(log.category || "activity")}</span></td>
                <td><span className="admin-value">{formatStatus(log.resourceType)}</span><span className="muted admin-value admin-technical-value" title={log.resourceId || "No resource ID"}>{log.resourceId || "No resource ID"}</span></td>
                <td><span className="admin-value admin-technical-value" title={log.metadata?.projectId || "No project ID"}>{log.metadata?.projectId || "—"}</span><span className="muted admin-value admin-technical-value" title={log.metadata?.pipelineRunId || "No run ID"}>{log.metadata?.pipelineRunId || "No Run ID"}</span></td>
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
                  <td className="admin-audit-detail-cell" colSpan="8">
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
