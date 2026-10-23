import { DataTable } from "../common/DesignSystem.jsx";
import Time from "../common/Time.jsx";
import UserRoleSelect from "./UserRoleSelect.jsx";

export default function UserTable({ onRoleChange, updatingUserId, users }) {
  return <DataTable caption="DeployGuard users and their roles" className="user-table" label="Users and roles">
    <thead><tr><th>User</th><th>GitHub</th><th>Role</th><th>Last sign-in</th></tr></thead>
    <tbody>{users.map((user) => <tr key={user.id}>
      <td data-label="User"><strong>{user.name || "Unnamed user"}</strong><span className="cell-sub" title={user.email || ""}>{user.email || "No email"}</span></td>
      <td data-label="GitHub">{user.githubLogin ? <span className="mono">@{user.githubLogin}</span> : <span className="muted">Not connected</span>}</td>
      <td data-label="Role">{user.provider === "github" ? <UserRoleSelect disabled={updatingUserId === user.id} onChange={(role) => onRoleChange(user.id, role)} value={user.role} /> : <span title="Administrator accounts use the separate email-and-password sign-in.">Admin</span>}</td>
      <td data-label="Last sign-in">{user.lastLoginAt ? <Time value={user.lastLoginAt} /> : <span className="muted">Never</span>}</td>
    </tr>)}</tbody>
  </DataTable>;
}
