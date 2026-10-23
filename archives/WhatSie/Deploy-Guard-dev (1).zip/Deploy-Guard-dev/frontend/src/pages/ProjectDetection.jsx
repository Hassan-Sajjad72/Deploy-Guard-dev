import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  getDetectionProfile,
  getProject,
  runStackDetection,
} from "../api/projectApi.js";
import EmptyState from "../components/common/EmptyState.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import DeploymentProfileCard from "../components/projects/DeploymentProfileCard.jsx";

export default function ProjectDetection() {
  const { projectId } = useParams();
  const [profile, setProfile] = useState(null);
  const [canManage, setCanManage] = useState(false);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    loadDetection();
  }, [projectId]);

  async function loadDetection() {
    setError("");
    setIsLoading(true);

    try {
      const projectResponse = await getProject(projectId);
      setCanManage(Boolean(projectResponse.project.canManage));

      try {
        const profileResponse = await getDetectionProfile(projectId);
        setProfile(profileResponse.profile);
      } catch {
        setProfile(null);
      }
    } catch (caughtError) {
      setError(caughtError.message);
    } finally {
      setIsLoading(false);
    }
  }

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

  if (isLoading) {
    return <LoadingState message="Loading detection profile..." />;
  }

  return (
    <div className="grid">
      <div className="page-header">
        <div>
          <h1>Stack Detection</h1>
          <p className="muted">Rule-based deployment profile for this project.</p>
        </div>
        {canManage ? (
          <button
            className="button"
            disabled={isRunning}
            onClick={runDetection}
            type="button"
          >
            {isRunning ? "Detecting..." : "Run Detection Again"}
          </button>
        ) : null}
      </div>

      {error ? <ErrorState message={error} /> : null}
      {!profile && !error ? (
        <EmptyState message="No detection profile has been generated yet." />
      ) : null}
      {profile ? <DeploymentProfileCard profile={profile} /> : null}
    </div>
  );
}
