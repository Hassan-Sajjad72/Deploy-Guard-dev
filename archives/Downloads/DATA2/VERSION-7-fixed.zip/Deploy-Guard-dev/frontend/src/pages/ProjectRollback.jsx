import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getOrchestrationStatus, rollbackOrchestration } from "../api/projectApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import RollbackPanel from "../components/orchestration/RollbackPanel.jsx";

export default function ProjectRollback() {
  const { projectId } = useParams();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadStatus();
  }, [projectId]);

  async function loadStatus() {
    setError("");
    setIsLoading(true);

    try {
      const response = await getOrchestrationStatus(projectId);
      setStatus(response);
    } catch (caughtError) {
      setError(caughtError.message);
    } finally {
      setIsLoading(false);
    }
  }

  async function rollback(reason) {
    setError("");
    setMessage("");

    try {
      await rollbackOrchestration(projectId, reason);
      setMessage("Rollback requested.");
      await loadStatus();
    } catch (caughtError) {
      setError(caughtError.message);
    }
  }

  if (isLoading) {
    return <LoadingState message="Loading rollback status..." />;
  }

  const stableRelease = status?.stableRelease || null;

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
      {stableRelease ? (
        <p className="muted">
          Will roll back to <strong>{stableRelease.imageTag || stableRelease.shortCommitSha || "the last stable release"}</strong>.
        </p>
      ) : (
        <p className="muted">No stable release is recorded yet, so rollback is unavailable.</p>
      )}
      <RollbackPanel
        canManage={Boolean(status?.canManage)}
        hasRelease={Boolean(stableRelease)}
        onRollback={rollback}
      />
    </div>
  );
}
