import { Outlet, useNavigate } from "react-router-dom";
import { adminSignOut } from "../../api/adminAuthApi.js";
import BrandLogo from "../common/BrandLogo.jsx";

export default function AdminLayout() {
  const navigate = useNavigate();
  async function logout() { await adminSignOut().catch(() => undefined); navigate("/admin/login", { replace: true }); }
  return <div className="admin-shell"><header className="admin-shell-header"><BrandLogo context="Administration" /><button className="subtle-button" onClick={logout} type="button">Admin logout</button></header><main className="app-main"><Outlet /></main></div>;
}
