import { useProductMode } from "../../hooks/useProductMode.js";

export default function BranchSelector({
  branches,
  disabled,
  onFetch,
  onSave,
  onSelect,
  selectedBranch,
}) {
  const { isDeveloperMode } = useProductMode();

  return (
    <div className="panel form-stack">
      <div><p className="eyebrow">Branch</p><h2>{isDeveloperMode ? "Select the branch DeployGuard should inspect" : "Choose the branch to deploy"}</h2><p className="muted">{isDeveloperMode ? "Fetch branches after updating the repository connection, then save the release target." : "Load available branches, then save the one you want DeployGuard to use."}</p></div>
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
          {isDeveloperMode ? "Fetch Repository Branches" : "Load Branches"}
        </button>
        <button
          className="secondary-button"
          disabled={disabled}
          onClick={onSave}
          type="button"
        >
          {isDeveloperMode ? "Update Release Branch" : "Save Branch"}
        </button>
      </div>
    </div>
  );
}
