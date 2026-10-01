import { Link } from "react-router-dom";
import "../styles/pages/gate.css";

export default function Forbidden() {
  return (
    <div className="auth-shell dg-gate is-forbidden">
      <section className="auth-panel">
        <p className="dg-gate-code">HTTP 403 · Forbidden</p>
        <h1>403</h1>
        <p>You do not have permission to access this page.</p>
        <Link className="button" to="/dashboard">
          Back to dashboard
        </Link>
      </section>
    </div>
  );
}
