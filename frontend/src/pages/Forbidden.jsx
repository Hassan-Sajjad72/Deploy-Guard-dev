import { Link } from "react-router-dom";

export default function Forbidden() {
  return (
    <div className="auth-shell">
      <section className="auth-panel">
        <h1>403</h1>
        <p>You do not have permission to access this page.</p>
        <Link className="button" to="/dashboard">
          Back to dashboard
        </Link>
      </section>
    </div>
  );
}
