import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { rollbackOrchestration } from "../api/projectApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import RollbackPanel from "../components/orchestration/RollbackPanel.jsx";

export default function ProjectRollback() {
  const { projectId } = useParams();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function rollback(reason) {
    setError("");
    setMessage("");

    try {
      await rollbackOrchestration(projectId, reason);
      setMessage("Rollback requested.");
    } catch (caughtError) {
      setError(caughtError.message);
    }
  }

  return (
    <div className="grid">
      <div className="page-header">
        <div>
          <h1>Rollback</h1>
          <p className="muted">Restore the previous stable ECS task definition.</p>
        </div>
        <Link className="secondary-button" to={`/projects/${projectId}/orchestration`}>
          Orchestration
        </Link>
      </div>
      {error ? <ErrorState message={error} /> : null}
      {message ? <p className="success">{message}</p> : null}
      <RollbackPanel canManage hasRelease onRollback={rollback} />
    </div>
  );
}
