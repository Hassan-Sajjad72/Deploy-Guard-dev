function formatDate(value) {
  return value
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "-";
}

export default function EnvVarTable({ canManage, managed = false, onDelete, onEdit, variables }) {
  return (
    <div className="table-wrap panel">
      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th>Value</th>
            <th>Scope</th>
            <th>Secret</th>
            <th>Required</th>
            <th>Updated</th>
            {canManage ? <th>Actions</th> : null}
          </tr>
        </thead>
        <tbody>
          {variables.map((variable) => (
            <tr key={variable.id}>
              <td>{variable.key}</td>
              <td>{managed ? "Managed by DeployGuard" : variable.maskedValue}</td>
              <td>{variable.scope}</td>
              <td>{variable.isSecret ? "yes" : "no"}</td>
              <td>{managed ? variable.category?.replaceAll("_", " ") || "managed" : variable.isRequired ? "yes" : "no"}</td>
              <td>{formatDate(variable.updatedAt)}</td>
              {canManage ? (
                <td>
                  {!variable.protected && !variable.isRequired && ["user_optional", "repository_default"].includes(variable.owner || "user_optional") ? <div className="quick-actions">
                    <button
                      className="secondary-button"
                      onClick={() => onEdit(variable)}
                      type="button"
                    >
                      Edit
                    </button>
                    <button
                      className="danger-button"
                      onClick={() => onDelete(variable.id)}
                      type="button"
                    >
                      Delete
                    </button>
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
