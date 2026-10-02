import { useEffect, useRef, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { adminSignOut } from "../../api/adminAuthApi.js";
import { ThemeSwitch } from "./AppHeader.jsx";

export const adminNavigation = [
  { label: "Overview", to: "/admin", section: "overview" },
  { label: "Users", to: "/admin?section=users", section: "users" },
  { label: "Projects", to: "/admin?section=projects", section: "projects" },
  { label: "Audit log", to: "/admin?section=audit", section: "audit" },
  { label: "Cloud cleanup", to: "/admin/cleanup", section: "cleanup" },
];

function AdminMenu({ onLogout }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event) => { if (!rootRef.current?.contains(event.target)) setOpen(false); };
    const onKey = (event) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return <div className="menu-root" ref={rootRef}>
    <button aria-expanded={open} aria-haspopup="menu" aria-label="Administrator account" className="account-trigger" onClick={() => setOpen((value) => !value)} type="button"><span aria-hidden="true" className="avatar">A</span></button>
    {open ? <div className="menu">
      <div className="account-identity"><strong>Administrator</strong><small>Platform console</small></div>
      <div className="menu-sep" />
      <div className="menu-label">Theme</div>
      <ThemeSwitch />
      <div className="menu-sep" />
      <button onClick={onLogout} type="button">Log out</button>
    </div> : null}
  </div>;
}

export default function AdminLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const section = location.pathname === "/admin/cleanup" ? "cleanup" : new URLSearchParams(location.search).get("section") || "overview";
  async function logout() { await adminSignOut().catch(() => undefined); navigate("/admin/login", { replace: true }); }
  return <div className="app">
    <a className="skip-link" href="#admin-main-content">Skip to main content</a>
    <header className="header">
      <div className="header-bar">
        <nav aria-label="Scope" className="scope">
          <Link aria-label="DeployGuard administration" className="brand" to="/admin"><img alt="" height="24" src="/deployguard-mark.svg" width="24" /><span>DeployGuard</span></Link>
          <span aria-hidden="true" className="scope-sep">/</span>
          <span aria-current="page" className="scope-current">Administration</span>
        </nav>
        <div className="header-actions"><AdminMenu onLogout={logout} /></div>
      </div>
      <nav aria-label="Administration" className="header-tabs">
        {adminNavigation.map((tab) => <Link aria-current={section === tab.section ? "page" : undefined} className={section === tab.section ? "header-tab is-active" : "header-tab"} key={tab.section} to={tab.to}>{tab.label}</Link>)}
      </nav>
    </header>
    <main className="app-main" id="admin-main-content" tabIndex={-1}><Outlet /></main>
  </div>;
}
