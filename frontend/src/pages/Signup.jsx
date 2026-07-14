import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import ErrorState from "../components/common/ErrorState.jsx";
import { useAuth } from "../hooks/useAuth.js";
import AppIcon from "../components/common/AppIcon.jsx";

export default function Signup() {
  const { isAuthenticated, signup } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    confirmPassword: "",
  });
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  function updateField(event) {
    setForm((current) => ({
      ...current,
      [event.target.name]: event.target.value,
    }));
  }

  function validate() {
    if (!form.name.trim()) {
      return "Name is required.";
    }

    if (!form.email.trim() || !form.email.includes("@")) {
      return "A valid email is required.";
    }

    if (form.password.length < 8) {
      return "Password must contain at least 8 characters.";
    }

    if (form.password !== form.confirmPassword) {
      return "Passwords must match.";
    }

    return "";
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const validationError = validate();

    if (validationError) {
      setError(validationError);
      return;
    }

    setError("");
    setIsSubmitting(true);

    try {
      await signup({
        name: form.name,
        email: form.email,
        password: form.password,
      });
      navigate("/dashboard", { replace: true });
    } catch (caughtError) {
      setError(caughtError.message);
    } finally {
      setIsSubmitting(false);
    }
  }

  if (isAuthenticated) return <Navigate replace to="/dashboard" />;

  return (
    <div className="auth-shell">
      <aside className="auth-story"><Link className="brand landing-brand" to="/"><span className="brand-mark"><span /></span><span>DeployGuard<small>Deployment platform</small></span></Link><div><p className="eyebrow">Start shipping</p><h1>From a GitHub repository to a visible deployment flow.</h1><p>Create a project and DeployGuard automatically detects, prepares, builds, scans, plans, and deploys through every enabled stage.</p></div><div className="auth-flow-line"><span>Connect</span><span>Build</span><span>Deploy</span><span>Observe</span></div></aside>
      <section className="auth-panel">
        <p className="eyebrow">Create your workspace</p><h1>Sign up</h1>
        <p className="muted">Create your DeployGuard account.</p>
        {error ? <ErrorState message={error} /> : null}
        <form className="form-stack" onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="name">Name</label>
            <input
              autoComplete="name"
              id="name"
              name="name"
              onChange={updateField}
              required
              type="text"
              value={form.name}
            />
          </div>
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
              autoComplete="new-password"
              id="password"
              name="password"
              minLength="8"
              onChange={updateField}
              required
              type="password"
              value={form.password}
            />
          </div>
          <div className="field">
            <label htmlFor="confirmPassword">Confirm password</label>
            <input
              autoComplete="new-password"
              id="confirmPassword"
              name="confirmPassword"
              minLength="8"
              onChange={updateField}
              required
              type="password"
              value={form.confirmPassword}
            />
          </div>
          <button className="secondary-button auth-submit" disabled={isSubmitting} type="submit">
            {isSubmitting ? "Creating account..." : "Signup"}
          </button>
          <Link
            className="button github-auth-button"
            to="/auth/github"
          >
            <AppIcon name="github" size={17} />Continue with GitHub
          </Link>
        </form>
        <p className="muted">
          Already have an account? <Link to="/login">Log in</Link>
        </p>
      </section>
    </div>
  );
}
