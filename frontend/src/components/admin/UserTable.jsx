import { DataTable, StatusChip } from "../common/DesignSystem.jsx";
import UserRoleSelect from "./UserRoleSelect.jsx";

function date(value) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "No recorded activity";
}

export default function UserTable({ onAccessChange, onRoleChange, updatingUserId, users }) {
  return <DataTable caption="GitHub-authenticated users and access controls" className="admin-responsive-table user-table" label="Users and roles table">
    <thead><tr><th>User</th><th>GitHub account</th><th>Role</th><th>Access</th><th>Last activity</th><th>Action</th></tr></thead>
    <tbody>{users.map((user) => <tr key={user.id}>
      <td data-label="User"><strong title={user.name || user.email || "Unavailable"}>{user.name || "Unnamed user"}</strong><span className="admin-cell-detail" title={user.email || "Unavailable"}>{user.email || "Unavailable"}</span></td>
      <td data-label="GitHub account" title={user.githubLogin || "No GitHub account"}>{user.githubLogin ? `@${user.githubLogin}` : "Not connected"}</td>
      <td data-label="Role"><UserRoleSelect disabled={updatingUserId === user.id} onChange={(role) => onRoleChange(user.id, role)} value={user.role} /></td>
      <td data-label="Access"><StatusChip status={user.enabled ? "active" : "disabled"}>{user.enabled ? "Enabled" : "Disabled"}</StatusChip></td>
      <td data-label="Last activity" title={user.lastLoginAt || "No recorded activity"}>{date(user.lastLoginAt)}</td>
      <td data-label="Action"><button className="secondary-button" disabled={updatingUserId === user.id} onClick={() => onAccessChange(user.id, !user.enabled)} type="button">{user.enabled ? "Disable access" : "Re-enable access"}</button></td>
    </tr>)}</tbody>
  </DataTable>;
}
