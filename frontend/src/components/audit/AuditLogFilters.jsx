export default function AuditLogFilters({ filters, onChange, onReset }) {
  function update(event) {
    onChange({ ...filters, page: 1, [event.target.name]: event.target.value });
  }
  return <div className="admin-audit-filters">
    <label className="field"><span>Search</span><input name="search" onChange={update} placeholder="Actor, action, or resource" value={filters.search || ""} /></label>
    <label className="field"><span>Actor ID</span><input min="1" name="actorUserId" onChange={update} type="number" value={filters.actorUserId || ""} /></label>
    <label className="field"><span>Action</span><input name="action" onChange={update} placeholder="For example: PROJECT CREATED" value={filters.action || ""} /></label>
    <label className="field"><span>Project ID</span><input name="projectId" onChange={update} value={filters.projectId || ""} /></label>
    <label className="field"><span>Result</span><select name="status" onChange={update} value={filters.status || ""}><option value="">All results</option><option value="success">Success</option><option value="failed">Failed</option><option value="warning">Warning</option><option value="blocked">Blocked</option></select></label>
    <label className="field"><span>Severity</span><select name="severity" onChange={update} value={filters.severity || ""}><option value="">All severities</option><option value="info">Informational</option><option value="warning">Attention</option><option value="error">Error</option></select></label>
    <label className="field"><span>From</span><input name="from" onChange={update} type="date" value={filters.from || ""} /></label>
    <label className="field"><span>To</span><input name="to" onChange={update} type="date" value={filters.to || ""} /></label>
    <button className="secondary-button" onClick={onReset} type="button">Reset filters</button>
  </div>;
}
