import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { getProject } from "../../api/projectApi.js";
import { useAuth } from "../../hooks/useAuth.js";
import { useTheme } from "../../hooks/useTheme.js";

/*
 * One header for the authenticated product. The scope (workspace or a single
 * project) decides which tab row is shown; there is no second navigation
 * surface. Navigation only reads the project name — it never polls state.
 */
export const workspaceNavigation = [
  { label: "Projects", to: "/projects" },
  { label: "Plan & usage", to: "/billing" },
];

export const projectNavigation = [
  { label: "Overview", path: "" },
  { label: "Deployments", path: "pipeline" },
  { label: "Infrastructure", path: "infrastructure" },
  { label: "Monitoring", path: "monitoring" },
  { label: "Troubleshoot", path: "troubleshooting" },
  { label: "Settings", path: "settings" },
];

function useProjectName(projectId) {
  const [names, setNames] = useState({});
  useEffect(() => {
    if (!projectId || names[projectId]) return undefined;
    let current = true;
    getProject(projectId)
      .then((response) => { if (current) setNames((known) => ({ ...known, [projectId]: response?.project?.name || "Project" })); })
      .catch(() => { if (current) setNames((known) => ({ ...known, [projectId]: "Project" })); });
    return () => { current = false; };
  }, [names, projectId]);
  return projectId ? names[projectId] || "" : "";
}

export function ThemeSwitch() {
  const { preference, setPreference } = useTheme();
  return <div aria-label="Theme" className="theme-switch" role="group">
    {[["system", "System"], ["light", "Light"], ["dark", "Dark"]].map(([value, label]) => <button aria-pressed={preference === value} key={value} onClick={() => setPreference(value)} type="button">{label}</button>)}
  </div>;
}

function AccountMenu() {
  const { logout, user } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const { pathname } = useLocation();
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event) => { if (!rootRef.current?.contains(event.target)) setOpen(false); };
    const onKey = (event) => { if (event.key === "Escape") { setOpen(false); rootRef.current?.querySelector("button")?.focus(); } };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey); };
  }, [open]);
  const handle = user?.githubLogin ? `@${user.githubLogin}` : user?.email || "Account";
  const initial = String(user?.name || user?.githubLogin || user?.email || "U").charAt(0).toUpperCase();
  async function handleLogout() { await logout().catch(() => undefined); navigate("/", { replace: true }); }
  return <div className="menu-root" ref={rootRef}>
    <button aria-controls="account-menu" aria-expanded={open} aria-haspopup="menu" aria-label="Account" className="account-trigger" onClick={() => setOpen((value) => !value)} type="button">
      {user?.avatarUrl ? <img alt="" className="avatar" height="30" src={user.avatarUrl} width="30" /> : <span aria-hidden="true" className="avatar">{initial}</span>}
    </button>
    {open ? <div className="menu" id="account-menu">
      <div className="account-identity"><strong>{user?.name || handle}</strong><small>{user?.name ? handle : "Signed in with GitHub"}{user?.role === "readonly" ? " · Read-only" : ""}</small></div>
      <div className="menu-sep" />
      <div className="menu-label">Theme</div>
      <ThemeSwitch />
      <div className="menu-sep" />
      <Link to="/billing">Plan & usage</Link>
      <button onClick={handleLogout} type="button">Log out</button>
    </div> : null}
  </div>;
}

export default function AppHeader({ projectId = null }) {
  const projectName = useProjectName(projectId);
  const { pathname } = useLocation();
  const tabsRef = useRef(null);
  // On narrow screens the tab row scrolls; keep the current tab in view.
  useEffect(() => { tabsRef.current?.querySelector(".is-active")?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [pathname]);
  const tabs = projectId
    ? projectNavigation.map((tab) => ({ label: tab.label, to: tab.path ? `/projects/${projectId}/${tab.path}` : `/projects/${projectId}`, end: !tab.path }))
    : workspaceNavigation;
  return <header className="header">
    <div className="header-bar">
      <nav aria-label="Scope" className="scope">
        <Link aria-label="DeployGuard projects" className="brand" to="/projects"><img alt="" height="24" src="/deployguard-mark.svg" width="24" /><span>DeployGuard</span></Link>
        {projectId ? <>
          <span aria-hidden="true" className="scope-sep">/</span>
          <Link className="scope-link" to="/projects">Projects</Link>
          <span aria-hidden="true" className="scope-sep">/</span>
          <span aria-current="page" className="scope-current" translate="no">{projectName || " "}</span>
        </> : null}
      </nav>
      <div className="header-actions"><AccountMenu /></div>
    </div>
    <nav aria-label={projectId ? "Project navigation" : "Workspace navigation"} className="header-tabs" ref={tabsRef}>
      {tabs.map((tab) => <NavLink className={({ isActive }) => isActive || (tab.to === "/projects" && pathname === "/deploy") ? "header-tab is-active" : "header-tab"} end={tab.end} key={tab.to} to={tab.to}>{tab.label}</NavLink>)}
    </nav>
  </header>;
}
