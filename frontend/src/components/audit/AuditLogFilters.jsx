import AppIcon from "../common/AppIcon.jsx";

export default function AuditLogFilters({ filters, onChange, onReset }) {
  function update(event) {
    onChange({ ...filters, page: 1, [event.target.name]: event.target.value });
  }
  const active = ["search", "action", "status", "severity", "from", "to"].some((key) => filters[key]);
  return <div className="audit-filters">
    <label className="field audit-search"><span>Search</span><span className="search"><AppIcon name="search" size={15} /><input className="input" name="search" onChange={update} placeholder="Actor, action or resource" value={filters.search || ""} /></span></label>
    <label className="field"><span>Action</span><input name="action" onChange={update} placeholder="e.g. PROJECT_CREATED" spellCheck={false} value={filters.action || ""} /></label>
    <label className="field"><span>Result</span><select name="status" onChange={update} value={filters.status || ""}><option value="">Any result</option><option value="success">Success</option><option value="failed">Failed</option><option value="warning">Warning</option><option value="blocked">Blocked</option></select></label>
    <label className="field"><span>Severity</span><select name="severity" onChange={update} value={filters.severity || ""}><option value="">Any severity</option><option value="info">Informational</option><option value="warning">Attention</option><option value="error">Error</option></select></label>
    <label className="field"><span>From</span><input name="from" onChange={update} type="date" value={filters.from || ""} /></label>
    <label className="field"><span>To</span><input name="to" onChange={update} type="date" value={filters.to || ""} /></label>
    <button className="btn btn-ghost audit-reset" disabled={!active} onClick={onReset} type="button">Clear filters</button>
  </div>;
}
