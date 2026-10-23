import { Link, Outlet, useNavigate } from "react-router-dom";
import { adminSignOut } from "../../api/adminAuthApi.js";
import BrandLogo from "../common/BrandLogo.jsx";
import "../../styles/pages/admin.css";

export default function AdminLayout() {
  const navigate = useNavigate();
  async function logout() { await adminSignOut().catch(() => undefined); navigate("/admin/login", { replace: true }); }
  return <div className="admin-shell dg-admin"><a className="skip-link" href="#admin-main-content">Skip to main content</a><header className="admin-shell-header"><Link aria-label="DeployGuard home" to="/"><BrandLogo context="Administration" /></Link><nav aria-label="Administration navigation" className="admin-shell-nav"><Link to="/admin">Overview</Link><Link to="/admin?section=users">Users &amp; Roles</Link><Link to="/admin?section=projects">Operations</Link><Link to="/admin?section=audit">Audit</Link><Link to="/admin/cleanup">Cloud Cleanup</Link></nav><button className="subtle-button" onClick={logout} type="button">Admin logout</button></header><main className="app-main" id="admin-main-content" tabIndex={-1}><Outlet /></main></div>;
}
