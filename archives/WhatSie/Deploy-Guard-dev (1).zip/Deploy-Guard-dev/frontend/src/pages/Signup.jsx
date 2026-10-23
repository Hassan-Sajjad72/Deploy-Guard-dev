import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { redirectToGithub } from "../api/authApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import { useAuth } from "../hooks/useAuth.js";

export default function Signup() {
  const { signup } = useAuth();
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

    if (!form.password) {
      return "Password is required.";
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

  return (
    <div className="auth-shell">
      <section className="auth-panel">
        <h1>Sign up</h1>
        <p className="muted">Create your Deploy Guard account.</p>
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
              onChange={updateField}
              required
              type="password"
              value={form.confirmPassword}
            />
          </div>
          <button className="button" disabled={isSubmitting} type="submit">
            {isSubmitting ? "Creating account..." : "Signup"}
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
          Already have an account? <Link className="ghost-button" to="/login">Log in</Link>
        </p>
      </section>
    </div>
  );
}
