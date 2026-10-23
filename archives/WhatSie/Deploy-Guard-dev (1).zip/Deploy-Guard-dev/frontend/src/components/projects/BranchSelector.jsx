export default function BranchSelector({
  branches,
  disabled,
  onFetch,
  onSave,
  onSelect,
  selectedBranch,
}) {
  return (
    <div className="panel form-stack">
      <div className="field">
        <label htmlFor="targetBranch">Target branch</label>
        <select
          disabled={disabled || branches.length === 0}
          id="targetBranch"
          onChange={(event) => onSelect(event.target.value)}
          value={selectedBranch}
        >
          {branches.length === 0 ? (
            <option value={selectedBranch}>{selectedBranch || "main"}</option>
          ) : null}
          {branches.map((branch) => (
            <option key={branch} value={branch}>
              {branch}
            </option>
          ))}
        </select>
      </div>
      <div className="quick-actions">
        <button
          className="secondary-button"
          disabled={disabled}
          onClick={onFetch}
          type="button"
        >
          Fetch Branches
        </button>
        <button
          className="button"
          disabled={disabled}
          onClick={onSave}
          type="button"
        >
          Save Branch
        </button>
      </div>
    </div>
  );
}
