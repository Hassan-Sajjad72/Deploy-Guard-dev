import { Outlet, useNavigate } from "react-router-dom";
import { adminSignOut } from "../../api/adminAuthApi.js";
import AppIcon from "../common/AppIcon.jsx";

export default function AdminLayout() {
  const navigate = useNavigate();
  async function logout() { await adminSignOut().catch(() => undefined); navigate("/admin/login", { replace: true }); }
  return <div className="admin-shell">
    <header className="admin-shell-header">
      <div className="admin-shell-brand"><span className="brand-mark"><span /></span><div><strong>DeployGuard</strong><small>Administration console</small></div></div>
      <div className="admin-shell-meta"><span><i />Operator session</span><button className="subtle-button" onClick={logout} type="button"><AppIcon name="arrow" size={14} />Admin logout</button></div>
    </header>
    <main className="app-main admin-main"><Outlet /></main>
  </div>;
}
