import { NavLink, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../../hooks/useAuth.js";
import AppIcon from "../common/AppIcon.jsx";

const primary = [
  { icon: "dashboard", label: "Dashboard", to: "/dashboard" },
  { icon: "box", label: "Projects", to: "/projects" },
];

const projectNavigation = [
  { icon: "dashboard", label: "Overview", path: "" },
  { icon: "pipeline", label: "Pipeline", path: "pipeline" },
  { icon: "logs", label: "Pipeline Events", path: "logs" },
  { icon: "settings", label: "Settings", path: "settings" },
];

export default function Sidebar() {
  const { logout, user } = useAuth();
  const { projectId } = useParams();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout().catch(() => undefined);
    navigate("/", { replace: true });
  }

  return <aside className="sidebar">
    <div className="sidebar-brand-row"><div className="brand"><span className="brand-mark"><span /></span><span>DeployGuard<small>Deployment platform</small></span></div></div>
    <nav aria-label="Main navigation" className="sidebar-primary-nav">{primary.map((link) => <NavLink className={({ isActive }) => isActive ? "nav-link active" : "nav-link"} key={link.to} to={link.to}><AppIcon name={link.icon} size={17} />{link.label}</NavLink>)}</nav>
    {projectId ? <div className="sidebar-section"><p className="sidebar-label">Project</p><nav aria-label="Project navigation">{projectNavigation.map((link) => { const to = link.path ? `/projects/${projectId}/${link.path}` : `/projects/${projectId}`; return <NavLink className={({ isActive }) => isActive ? "nav-link active" : "nav-link"} end={!link.path} key={link.label} to={to}><AppIcon name={link.icon} size={17} />{link.label}</NavLink>; })}</nav></div> : null}
    <div className="sidebar-footer">
      <div className="sidebar-account">{user?.avatarUrl ? <img alt="" className="user-avatar" src={user.avatarUrl} /> : <span className="user-avatar">{String(user?.name || user?.githubLogin || "U").charAt(0).toUpperCase()}</span>}<span><strong>{user?.githubLogin ? `@${user.githubLogin}` : user?.name || "GitHub user"}</strong><small>GitHub account</small></span></div>
      <button className="sidebar-logout-button" onClick={handleLogout} type="button"><AppIcon name="arrow" size={15} />Logout</button>
    </div>
  </aside>;
}
