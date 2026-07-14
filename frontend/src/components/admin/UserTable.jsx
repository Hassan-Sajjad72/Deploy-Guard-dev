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

export default function UserTable({ onRoleChange, updatingUserId, users }) {
  return (
    <div className="table-wrap panel">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Provider</th>
            <th>Role</th>
            <th>Created At</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id}>
              <td>{user.name || "-"}</td>
              <td>{user.email || "-"}</td>
              <td>{user.provider || "-"}</td>
              <td>{user.role}</td>
              <td>{formatDate(user.createdAt)}</td>
              <td>
                <UserRoleSelect
                  disabled={updatingUserId === user.id}
                  onChange={(role) => onRoleChange(user.id, role)}
                  value={user.role}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
