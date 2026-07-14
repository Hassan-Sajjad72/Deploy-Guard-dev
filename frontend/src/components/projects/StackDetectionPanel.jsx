import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  getDetectionProfile,
  runStackDetection,
} from "../../api/projectApi.js";
import ErrorState from "../common/ErrorState.jsx";

export default function StackDetectionPanel({ canManage, projectId }) {
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState("");
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    async function loadProfile() {
      try {
        const response = await getDetectionProfile(projectId);
        setProfile(response.profile);
      } catch {
        setProfile(null);
      }
    }

    loadProfile();
  }, [projectId]);

  async function runDetection() {
    setError("");
    setIsRunning(true);

    try {
      const response = await runStackDetection(projectId);
      setProfile(response.profile);
    } catch (caughtError) {
      setError(caughtError.message);
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <section className="panel">
      <div className="page-header">
        <div>
          <h2>Stack Detection</h2>
          <p className="muted">
            {profile ? `Status: ${profile.detectionStatus}` : "Not run yet"}
          </p>
        </div>
        <div className="quick-actions">
          <Link className="secondary-button" to={`/projects/${projectId}/detection`}>
            View Profile
          </Link>
          {canManage ? (
            <button
              className="button"
              disabled={isRunning}
              onClick={runDetection}
              type="button"
            >
              {isRunning ? "Detecting..." : "Run Stack Detection"}
            </button>
          ) : null}
        </div>
      </div>
      {error ? <ErrorState message={error} /> : null}
      {profile ? (
        <>
        {profile.cloneError ? <div className="state error">Clone error: {profile.cloneError}</div> : null}
        {profile.branchError ? <div className="state error">Branch error: {profile.branchError}</div> : null}
        {profile.unsupportedReason ? <div className="state warning">{profile.unsupportedReason}</div> : null}
        <dl className="details-list">
          <dt>Ecosystem</dt>
          <dd>{profile.ecosystem}</dd>
          <dt>Framework</dt>
          <dd>{profile.framework}</dd>
          <dt>Template</dt>
          <dd>{profile.selectedTemplate || "none"}</dd>
          <dt>App directory</dt>
          <dd>{profile.appDirectory || "not found"}</dd>
          <dt>Manifests</dt>
          <dd>{profile.manifestFiles?.length ? profile.manifestFiles.join(", ") : "none"}</dd>
        </dl>
        </>
      ) : null}
    </section>
  );
}
