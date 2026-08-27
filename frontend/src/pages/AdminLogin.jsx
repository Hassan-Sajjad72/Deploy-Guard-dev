import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { adminMe, adminSignIn } from "../api/adminAuthApi.js";
import BrandLogo from "../components/common/BrandLogo.jsx";

export default function AdminLogin() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  if (authenticated) return <Navigate replace to="/admin" />;
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError("");
    try { await adminSignIn(form); await adminMe(); setAuthenticated(true); navigate("/admin", { replace: true }); }
    catch (caught) { setError(caught.message || "Admin sign-in failed."); }
    finally { setBusy(false); }
  }
  return <main className="auth-page"><section className="auth-card"><Link aria-label="DeployGuard home" className="auth-brand" to="/"><BrandLogo context="Administration" /></Link><p className="eyebrow">Dedicated operator access</p><h1>Admin sign in</h1><p className="muted">Use the dedicated administrator email and password. GitHub accounts cannot enter this console.</p><form onSubmit={submit}><label className="field"><span>Email</span><input autoComplete="username" onChange={(event) => setForm({ ...form, email: event.target.value })} required type="email" value={form.email} /></label><label className="field"><span>Password</span><input autoComplete="current-password" onChange={(event) => setForm({ ...form, password: event.target.value })} required type="password" value={form.password} /></label>{error ? <p className="form-error" role="alert">{error}</p> : null}<button className="button" disabled={busy} type="submit">{busy ? "Signing in…" : "Sign in as Admin"}</button></form></section></main>;
}
