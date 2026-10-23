import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { redirectToGithub } from "../api/authApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import { useAuth } from "../hooks/useAuth.js";

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
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
      navigate("/dashboard", { replace: true });
    } catch (caughtError) {
      setError(caughtError.message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="auth-shell">
      <section className="auth-panel">
        <h1>Log in</h1>
        <p className="muted">Access your Deploy Guard workspace.</p>
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
              onChange={updateField}
              required
              type="password"
              value={form.password}
            />
          </div>
          <button className="button" disabled={isSubmitting} type="submit">
            {isSubmitting ? "Logging in..." : "Login"}
          </button>
          <button
            className="secondary-button"
            onClick={redirectToGithub}
            type="button"
          >
            Continue with GitHub
          </button>
        </form>
        <p className="muted">
          Need an account? <Link className="ghost-button" to="/signup">Sign up</Link>
        </p>
      </section>
    </div>
  );
}
