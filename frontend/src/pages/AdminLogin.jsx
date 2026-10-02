import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { adminMe, adminSignIn } from "../api/adminAuthApi.js";
import BrandLogo from "../components/common/BrandLogo.jsx";
import { Callout } from "../components/common/DesignSystem.jsx";

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
  return <main className="center-page dg-admin-login">
    <section aria-labelledby="admin-login-title" className="center-card">
      <Link aria-label="DeployGuard home" to="/"><BrandLogo context="Administration" /></Link>
      <div><h1 id="admin-login-title">Administrator sign in</h1><p>Use the administrator email and password. GitHub accounts cannot sign in here.</p></div>
      <form className="panel panel-pad auth-form" onSubmit={submit}>
        <label className="field"><span>Email</span><input autoComplete="username" name="email" onChange={(event) => setForm({ ...form, email: event.target.value })} required type="email" value={form.email} /></label>
        <label className="field"><span>Password</span><input autoComplete="current-password" name="password" onChange={(event) => setForm({ ...form, password: event.target.value })} required type="password" value={form.password} /></label>
        {error ? <Callout tone="danger"><p>{error}</p></Callout> : null}
        <button aria-busy={busy || undefined} className="btn btn-primary" disabled={busy} type="submit">{busy ? "Signing in…" : "Sign in"}</button>
      </form>
      <Link className="link auth-back" to="/">Back to DeployGuard</Link>
    </section>
  </main>;
}
