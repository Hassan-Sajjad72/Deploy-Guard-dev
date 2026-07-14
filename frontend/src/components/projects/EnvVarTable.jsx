function formatDate(value) {
  return value
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "-";
}

export default function EnvVarTable({ canManage, onDelete, onEdit, variables }) {
  return (
    <div className="table-wrap panel">
      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th>Value</th>
            <th>Secret</th>
            <th>Updated</th>
            {canManage ? <th>Actions</th> : null}
          </tr>
        </thead>
        <tbody>
          {variables.map((variable) => (
            <tr key={variable.id}>
              <td>{variable.key}</td>
              <td>{variable.maskedValue}</td>
              <td>{variable.isSecret ? "yes" : "no"}</td>
              <td>{formatDate(variable.updatedAt)}</td>
              {canManage ? (
                <td>
                  <div className="quick-actions">
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
                  </div>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
