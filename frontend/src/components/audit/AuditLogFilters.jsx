export default function AuditLogFilters({ filters, onChange, onReset, embedded = false }) {
  function updateFilter(event) {
    onChange({
      ...filters,
      page: 1,
      [event.target.name]: event.target.value,
    });
  }

  return (
    <div className={embedded ? "" : "panel"}>
      <div className="filters">
        <div className="field">
          <label htmlFor="action">Action</label>
          <input
            id="action"
            name="action"
            onChange={updateFilter}
            value={filters.action || ""}
          />
        </div>
        <div className="field">
          <label htmlFor="resourceType">Resource type</label>
          <input
            id="resourceType"
            name="resourceType"
            onChange={updateFilter}
            value={filters.resourceType || ""}
          />
        </div>
        <div className="field">
          <label htmlFor="resourceId">Resource ID</label>
          <input
            id="resourceId"
            name="resourceId"
            onChange={updateFilter}
            value={filters.resourceId || ""}
          />
        </div>
        <div className="field">
          <label htmlFor="status">Status</label>
          <input
            id="status"
            name="status"
            onChange={updateFilter}
            value={filters.status || ""}
          />
        </div>
        <div className="field">
          <label htmlFor="from">From</label>
          <input
            id="from"
            name="from"
            onChange={updateFilter}
            type="date"
            value={filters.from || ""}
          />
        </div>
        <div className="field">
          <label htmlFor="to">To</label>
          <input
            id="to"
            name="to"
            onChange={updateFilter}
            type="date"
            value={filters.to || ""}
          />
        </div>
      </div>
      <button className="secondary-button" onClick={onReset} type="button">
        Reset filters
      </button>
    </div>
  );
}
