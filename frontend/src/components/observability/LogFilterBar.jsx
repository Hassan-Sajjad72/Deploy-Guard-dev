export default function LogFilterBar({ filters, onChange, onRefresh }) {
  function set(key, value) {
    onChange({ ...filters, [key]: value });
  }

  return (
    <section className="panel">
      <h2>Log Filters</h2>
      <div className="form-grid">
        <label>
          Log group
          <input value={filters.logGroupName || ""} onChange={(event) => set("logGroupName", event.target.value)} />
        </label>
        <label>
          Log stream
          <input value={filters.logStreamName || ""} onChange={(event) => set("logStreamName", event.target.value)} />
        </label>
        <label>
          Task ID
          <input value={filters.taskId || ""} onChange={(event) => set("taskId", event.target.value)} />
        </label>
        <label>
          Limit
          <input min="1" max="100" type="number" value={filters.limit || 50} onChange={(event) => set("limit", event.target.value)} />
        </label>
      </div>
      <button className="primary-button" onClick={onRefresh} type="button">Refresh</button>
    </section>
  );
}
