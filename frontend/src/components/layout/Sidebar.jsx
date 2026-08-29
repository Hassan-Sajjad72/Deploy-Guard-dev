import { useEffect, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../../hooks/useAuth.js";
import { getProjectCurrentState } from "../../api/projectApi.js";
import AppIcon from "../common/AppIcon.jsx";
import { projectStatePresentation } from "../../utils/projectStatePresentation.js";
import BrandLogo from "../common/BrandLogo.jsx";

const primary = [
  { icon: "dashboard", label: "Home", to: "/dashboard" },
  { icon: "box", label: "Projects", to: "/projects" },
];

const projectNavigation = [
  { icon: "dashboard", label: "Overview", path: "" },
  { icon: "pipeline", label: "Pipeline", path: "pipeline" },
  { icon: "infrastructure", label: "Infrastructure", path: "infrastructure", when: (state) => ["DEPLOYING", "FAILED", "LIVE", "DESTROYING"].includes(state?.state) },
  { icon: "activity", label: "Monitoring", path: "monitoring", when: (state) => state?.runtime?.state === "present" },
  { icon: "settings", label: "Settings", path: "settings" },
  { icon: "logs", label: "Troubleshoot", path: "troubleshooting", when: (state) => state?.state === "FAILED" },
];

function ProjectLinks({ links, onNavigate, projectId }) {
  return links.map((link) => { const to = link.path ? `/projects/${projectId}/${link.path}` : `/projects/${projectId}`; return <NavLink className={({ isActive }) => isActive ? "nav-link active" : "nav-link"} end={!link.path} key={link.label} onClick={onNavigate} to={to}><AppIcon name={link.icon} size={17} />{link.label}</NavLink>; });
}

export default function Sidebar({ isOpen = false, onClose, projectId: projectIdProp = null }) {
  const { logout, user } = useAuth();
  const { projectId: routeProjectId } = useParams();
  const projectId = projectIdProp || routeProjectId || null;
  const navigate = useNavigate();
  const [projectState, setProjectState] = useState(null);
  useEffect(() => {
    let active = true;
    if (!projectId) { setProjectState(null); return undefined; }
    async function refresh() {
      try { const state = await getProjectCurrentState(projectId); if (active) setProjectState(projectStatePresentation(state)); } catch { if (active) setProjectState(null); }
    }
    void refresh();
    // The route owns active-operation refreshes. This slower navigation probe
    // keeps links current without competing with its 4–5s status polling.
    const timer = window.setInterval(refresh, 15000);
    return () => { active = false; window.clearInterval(timer); };
  }, [projectId]);
  async function handleLogout() { await logout().catch(() => undefined); onClose?.(); navigate("/", { replace: true }); }
  return <>
    <button aria-label="Close navigation" className={isOpen ? "mobile-navigation-backdrop is-open" : "mobile-navigation-backdrop"} onClick={onClose} type="button" />
    <aside aria-label="Authenticated navigation" className={isOpen ? "sidebar glass-elevated is-mobile-open" : "sidebar glass-elevated"} id="authenticated-navigation">
      <div className="sidebar-brand-row"><BrandLogo /><button aria-label="Close navigation" className="mobile-navigation-close" onClick={onClose} type="button"><AppIcon name="close" size={19} /></button></div>
      <nav aria-label="Main navigation" className="sidebar-primary-nav">{primary.map((link) => <NavLink className={({ isActive }) => isActive ? "nav-link active" : "nav-link"} key={link.to} onClick={onClose} to={link.to}><AppIcon name={link.icon} size={17} />{link.label}</NavLink>)}</nav>
      {projectId ? <div className="sidebar-section"><p className="sidebar-label">Selected project</p><nav aria-label="Project navigation"><ProjectLinks links={projectNavigation.filter((link) => !link.when || link.when(projectState))} onNavigate={onClose} projectId={projectId} /></nav></div> : null}
      <div className="sidebar-footer"><div className="sidebar-account">{user?.avatarUrl ? <img alt="" className="user-avatar" src={user.avatarUrl} /> : <span className="user-avatar">{String(user?.name || user?.email || "U").charAt(0).toUpperCase()}</span>}<span><strong>{user?.githubLogin ? `@${user.githubLogin}` : user?.name || user?.email || "User"}</strong><small>GitHub account</small></span></div><button className="sidebar-logout-button" onClick={handleLogout} type="button"><AppIcon name="arrow" size={15} />Logout</button></div>
    </aside>
  </>;
}
