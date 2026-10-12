import { useEffect, useRef, useState } from "react";
import { Link, Navigate, Outlet, useLocation, useNavigate, useOutletContext } from "react-router-dom";
import { adminSignOut } from "../../api/adminAuthApi.js";
import { ThemeSwitch } from "./AppHeader.jsx";
import { BrandMark } from "../common/BrandLogo.jsx";
import { adminLandingPath, adminSectionAllowed } from "../../utils/adminScope.js";

export const adminNavigation = [
  { label: "Overview", to: "/admin", section: "overview" },
  { label: "Users", to: "/admin?section=users", section: "users" },
  { label: "Projects", to: "/admin?section=projects", section: "projects" },
  { label: "Audit log", to: "/admin?section=audit", section: "audit" },
  { label: "Billing", to: "/admin/billing", section: "billing" },
  { label: "Entitlements", to: "/admin/entitlements", section: "entitlements" },
  { label: "Privileged access", to: "/admin/access", section: "access" },
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
  const { adminUser } = useOutletContext();
  const navigate = useNavigate();
  const location = useLocation();
  const section = location.pathname === "/admin/billing" ? "billing" : location.pathname === "/admin/entitlements" ? "entitlements" : location.pathname === "/admin/access" ? "access" : new URLSearchParams(location.search).get("section") || "overview";
  async function logout() { await adminSignOut().catch(() => undefined); navigate("/admin/login", { replace: true }); }
  if (!adminSectionAllowed(adminUser?.internalAdminRole, section)) return <Navigate replace to={adminLandingPath(adminUser?.internalAdminRole)} />;
  return <div className="app">
    <a className="skip-link" href="#admin-main-content">Skip to main content</a>
    <header className="header">
      <div className="header-bar">
        <nav aria-label="Scope" className="scope">
          <Link aria-label="DeployGuard administration" className="brand" to="/admin"><BrandMark /><span>DeployGuard</span></Link>
          <span aria-hidden="true" className="scope-sep">/</span>
          <span aria-current="page" className="scope-current">Administration</span>
        </nav>
        <div className="header-actions"><AdminMenu onLogout={logout} /></div>
      </div>
      <nav aria-label="Administration" className="header-tabs">
        {adminNavigation.filter((tab) => adminSectionAllowed(adminUser?.internalAdminRole, tab.section)).map((tab) => <Link aria-current={section === tab.section ? "page" : undefined} className={section === tab.section ? "header-tab is-active" : "header-tab"} key={tab.section} to={tab.to}>{tab.label}</Link>)}
      </nav>
    </header>
    <main className="app-main" id="admin-main-content" tabIndex={-1}><Outlet context={{ adminUser }} /></main>
  </div>;
}
