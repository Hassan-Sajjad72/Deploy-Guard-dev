import Time from "../common/Time.jsx";

const SCOPES = { runtime: "Runtime", build: "Build", both: "Build and runtime" };

export default function EnvVarTable({ canManage, managed = false, onDelete, onEdit, variables }) {
  return (
    <div className="table-wrap table-stack">
      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Value</th>
            <th>Available during</th>
            {managed ? <th>Set by</th> : <th>Updated</th>}
            {canManage ? <th><span className="sr-only">Actions</span></th> : null}
          </tr>
        </thead>
        <tbody>
          {variables.map((variable) => (
            <tr key={variable.id || variable.key}>
              <td data-label="Name"><span className="mono">{variable.key}</span>{variable.isRequired && !managed ? <span className="cell-sub">Required</span> : null}</td>
              <td data-label="Value">{managed ? <span className="muted">Managed by DeployGuard</span> : <span className="mono muted">{variable.isSecret ? "••••••••" : variable.maskedValue || "••••••••"}</span>}</td>
              <td data-label="Available during">{SCOPES[variable.scope] || variable.scope || "Runtime"}</td>
              {managed ? <td data-label="Set by">{variable.category?.replaceAll("_", " ") || "DeployGuard"}</td> : <td data-label="Updated">{variable.updatedAt ? <Time value={variable.updatedAt} /> : "—"}</td>}
              {canManage ? (
                <td className="cell-end" data-label="">
                  {!variable.protected && !variable.isRequired && ["user_optional", "repository_default"].includes(variable.owner || "user_optional") ? <div className="actions actions-end">
                    <button className="btn btn-sm btn-ghost" onClick={() => onEdit(variable)} type="button">Edit</button>
                    <button className="btn btn-sm btn-ghost env-delete" onClick={() => onDelete(variable.id)} type="button">Delete</button>
                  </div> : <span className="muted">Managed elsewhere</span>}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
