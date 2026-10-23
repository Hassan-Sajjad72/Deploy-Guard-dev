import UserRoleSelect from "./UserRoleSelect.jsx";

function formatDate(value) {
  if (!value) {
    return "-";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export default function UserTable({ onAccessChange, onRoleChange, updatingUserId, users }) {
  return (
    <div aria-label="Users and roles table" className="admin-table-wrap" tabIndex="0">
      <table className="admin-table user-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Provider</th>
            <th>Role</th>
            <th>Access</th>
            <th>Last login</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id}>
              <td><span className="admin-value" title={user.name || "Unavailable"}>{user.name || "-"}</span></td>
              <td><span className="admin-value" title={user.email || "Unavailable"}>{user.email || "-"}</span></td>
              <td><span className="admin-value">{user.provider === "github" ? "GitHub" : user.provider || "-"}</span></td>
              <td><span className="admin-value">{user.role ? `${user.role.charAt(0).toUpperCase()}${user.role.slice(1)}` : "-"}</span></td>
              <td><span className="admin-value">{user.enabled ? "Enabled" : "Disabled"}</span></td>
              <td><span className="admin-value" title={user.lastLoginAt || "No recorded login"}>{formatDate(user.lastLoginAt)}</span></td>
              <td><div className="admin-table-actions">
                <UserRoleSelect
                  disabled={updatingUserId === user.id}
                  onChange={(role) => onRoleChange(user.id, role)}
                  value={user.role}
                />
                <button className="subtle-button" disabled={updatingUserId === user.id} onClick={() => onAccessChange(user.id, !user.enabled)} type="button">{user.enabled ? "Disable" : "Enable"}</button>
              </div></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
