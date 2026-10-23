import { Fragment, useState } from "react";
import AuditLogDetails from "./AuditLogDetails.jsx";

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
            <th>Actor Email</th>
            <th>Actor Role</th>
            <th>Action</th>
            <th>Resource Type</th>
            <th>Resource ID</th>
            <th>Status</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((log) => (
            <Fragment key={log.id}>
              <tr>
                <td>{formatDate(log.createdAt)}</td>
                <td>{log.actorEmail || "-"}</td>
                <td>{log.actorRole || "-"}</td>
                <td>{log.action}</td>
                <td>{log.resourceType}</td>
                <td>{log.resourceId || "-"}</td>
                <td>{log.status}</td>
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
                    {openLogId === log.id ? "Hide" : "View"}
                  </button>
                </td>
              </tr>
              {openLogId === log.id ? (
                <tr>
                  <td colSpan="8">
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
