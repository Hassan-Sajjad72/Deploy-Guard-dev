import { useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import ErrorState from "../components/common/ErrorState.jsx";
import { useAuth } from "../hooks/useAuth.js";
import AppIcon from "../components/common/AppIcon.jsx";

export default function Login() {
  const { isAuthenticated, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  function updateField(event) {
    setForm((current) => ({
      ...current,
      [event.target.name]: event.target.value,
    }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);

    try {
      await login(form);
      const from = location.state?.from;
      navigate(from ? `${from.pathname || ""}${from.search || ""}${from.hash || ""}` : "/dashboard", { replace: true });
    } catch (caughtError) {
      setError(caughtError.message);
    } finally {
      setIsSubmitting(false);
    }
  }

  if (isAuthenticated) return <Navigate replace to="/dashboard" />;

  return (
    <div className="auth-shell">
      <aside className="auth-story"><Link className="brand landing-brand" to="/"><span className="brand-mark"><span /></span><span>DeployGuard<small>Deployment platform</small></span></Link><div><p className="eyebrow">Welcome back</p><h1>Pick up exactly where your deployment left off.</h1><p>Active stage, sanitized logs, failure recovery, and the live application URL stay together in one workspace.</p></div><div className="auth-flow-line"><span>Connect</span><span>Build</span><span>Deploy</span><span>Observe</span></div></aside>
      <section className="auth-panel">
        <p className="eyebrow">Workspace access</p><h1>Log in</h1>
        <p className="muted">Access your DeployGuard workspace.</p>
        {error ? <ErrorState message={error} /> : null}
        <form className="form-stack" onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              autoComplete="email"
              id="email"
              name="email"
              onChange={updateField}
              required
              type="email"
              value={form.email}
            />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              autoComplete="current-password"
              id="password"
              name="password"
              minLength="8"
              onChange={updateField}
              required
              type="password"
              value={form.password}
            />
          </div>
          <button className="secondary-button auth-submit" disabled={isSubmitting} type="submit">
            {isSubmitting ? "Logging in..." : "Login"}
          </button>
          <Link
            className="button github-auth-button"
            state={{ from: location.state?.from }}
            to="/auth/github"
          >
            <AppIcon name="github" size={17} />Continue with GitHub
          </Link>
        </form>
        <p className="muted">
          Need an account? <Link to="/signup">Sign up</Link>
        </p>
      </section>
    </div>
  );
}
