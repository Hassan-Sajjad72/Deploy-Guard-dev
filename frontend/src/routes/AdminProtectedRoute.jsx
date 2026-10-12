import { useEffect, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { adminMe } from "../api/adminAuthApi.js";

export default function AdminProtectedRoute() {
  const location = useLocation();
  const [state, setState] = useState({ loading: true, allowed: false, user: null });
  useEffect(() => { let active = true; adminMe().then((value) => { if (active) setState({ loading: false, allowed: value?.user?.role === "admin", user: value.user }); }).catch(() => { if (active) setState({ loading: false, allowed: false, user: null }); }); return () => { active = false; }; }, []);
  if (state.loading) return <div className="loading-state">Checking admin session…</div>;
  return state.allowed ? <Outlet context={{ adminUser: state.user }} /> : <Navigate replace state={{ from: location }} to="/admin/login" />;
}
