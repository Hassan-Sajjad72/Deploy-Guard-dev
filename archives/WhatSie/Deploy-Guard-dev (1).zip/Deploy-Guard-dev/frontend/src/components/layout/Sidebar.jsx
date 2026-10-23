import { NavLink } from "react-router-dom";
import { useAuth } from "../../hooks/useAuth.js";

const links = [
  { label: "Dashboard", to: "/dashboard", roles: ["admin", "developer", "readonly"] },
  { label: "Projects", to: "/projects", roles: ["admin", "developer", "readonly"] },
  { label: "Create Project", to: "/projects/new", roles: ["admin", "developer"] },
  { label: "Audit Logs", to: "/audit-logs", roles: ["admin", "developer", "readonly"] },
  { label: "Admin Users", to: "/admin/users", roles: ["admin"] },
];

export default function Sidebar() {
  const { role } = useAuth();

  return (
    <aside className="sidebar">
      <div className="brand">Deploy Guard</div>
      <nav aria-label="Main navigation">
        {links
          .filter((link) => link.roles.includes(role))
          .map((link) => (
            <NavLink
              className={({ isActive }) =>
                isActive ? "nav-link active" : "nav-link"
              }
              key={link.to}
              to={link.to}
            >
              {link.label}
            </NavLink>
          ))}
      </nav>
    </aside>
  );
}
