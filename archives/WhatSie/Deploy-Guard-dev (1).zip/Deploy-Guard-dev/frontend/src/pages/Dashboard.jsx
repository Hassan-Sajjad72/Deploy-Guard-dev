import { Link } from "react-router-dom";
import { useAuth } from "../hooks/useAuth.js";

const actionsByRole = {
  admin: [
    { label: "View Projects", to: "/projects" },
    { label: "Create Project", to: "/projects/new" },
    { label: "Manage Users", to: "/admin/users" },
    { label: "View Audit Logs", to: "/audit-logs" },
  ],
  developer: [
    { label: "View Projects", to: "/projects" },
    { label: "Create Project", to: "/projects/new" },
    { label: "View Audit Logs", to: "/audit-logs" },
  ],
  readonly: [
    { label: "View Projects", to: "/projects" },
    { label: "View Audit Logs", to: "/audit-logs" },
  ],
};

export default function Dashboard() {
  const { role, user } = useAuth();
  const quickActions = actionsByRole[role] || [];

  return (
    <div className="grid">
      <div className="page-header">
        <div>
          <h1>Dashboard</h1>
          <p className="muted">Your account and available actions.</p>
        </div>
      </div>

      <section className="panel user-card">
        {user?.avatarUrl ? (
          <img alt="" className="avatar" src={user.avatarUrl} />
        ) : null}
        <div>
          <h2>{user?.name || "Unnamed user"}</h2>
          <p className="muted">{user?.email || "No email available"}</p>
          <strong>Role: {role || "unknown"}</strong>
        </div>
      </section>

      <section className="panel">
        <h2>Quick actions</h2>
        <div className="quick-actions">
          {quickActions.map((action) => (
            <Link className="button" key={action.to} to={action.to}>
              {action.label}
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
