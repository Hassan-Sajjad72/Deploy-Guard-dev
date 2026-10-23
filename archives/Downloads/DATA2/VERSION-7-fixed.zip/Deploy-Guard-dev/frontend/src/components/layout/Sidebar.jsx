import { useEffect, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../../hooks/useAuth.js";
import { getProjects } from "../../api/projectApi.js";
import AppIcon from "../common/AppIcon.jsx";

const links = [
  { icon: "dashboard", label: "Overview", to: "/dashboard", roles: ["admin", "developer", "readonly"] },
  { icon: "box", label: "Projects", to: "/projects", roles: ["admin", "developer", "readonly"] },
  { icon: "activity", label: "Activity", to: "/audit-logs", roles: ["admin", "developer", "readonly"] },
  { icon: "user", label: "Team", to: "/admin/users", roles: ["admin"] },
];

const projectLinks = [
  { icon: "dashboard", label: "Project home", path: "" },
  { icon: "pipeline", label: "Deployments", path: "pipeline" },
  { icon: "activity", label: "Runtime", path: "observability" },
  { icon: "settings", label: "Settings", path: "settings" },
];

export default function Sidebar() {
  const { role } = useAuth();
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [projects, setProjects] = useState([]);

  useEffect(() => {
    let active = true;
    getProjects().then((response) => active && setProjects(response.projects || [])).catch(() => active && setProjects([]));
    return () => { active = false; };
  }, [projectId]);

  return (
    <aside className="sidebar">
      <div className="sidebar-brand-row"><div className="brand">
        <span className="brand-mark"><span /></span>
        <span>
          DeployGuard
          <small>Deployment platform</small>
        </span>
      </div></div>
      <label className="workspace-switcher">
        <span>Project workspace</span>
        <select aria-label="Switch project workspace" onChange={(event) => event.target.value && navigate(`/projects/${event.target.value}`)} value={projectId || ""}>
          <option value="">All projects</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </label>
      <nav aria-label="Main navigation" className="sidebar-primary-nav">
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
              <AppIcon name={link.icon} size={17} />
              {link.label}
            </NavLink>
          ))}
      </nav>

      <div className="sidebar-section">
        <p className="sidebar-label">{projectId ? "Selected project" : "Project navigation"}</p>
        {projectId ? (
          <nav aria-label="Project navigation">
            {projectLinks.map((link) => {
              const to = link.path
                ? `/projects/${projectId}/${link.path}`
                : `/projects/${projectId}`;
              return (
                <NavLink
                  className={({ isActive }) =>
                    isActive ? "nav-link active" : "nav-link"
                  }
                  key={link.label}
                  to={to}
                >
                  <AppIcon name={link.icon} size={17} />
                  {link.label}
                </NavLink>
              );
            })}
          </nav>
        ) : (
          <div className="sidebar-empty">
            Choose a project above to open deployment controls.
          </div>
        )}
      </div>
      <div className="sidebar-footer"><span className="sidebar-status-dot" /><span>DeployGuard worker</span><strong>Connected</strong></div>
    </aside>
  );
}
