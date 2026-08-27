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
import { PageHeader } from "../components/common/Premium.jsx";
import DeploymentProfileCard from "../components/projects/DeploymentProfileCard.jsx";
import ProjectModuleStatusStrip from "../components/projects/ProjectModuleStatusStrip.jsx";
import PreflightPanel from "../components/projects/PreflightPanel.jsx";
import { useToast } from "../hooks/useToast.js";
import { publishProjectStateChanged } from "../utils/projectStateSync.js";

export default function ProjectDetection() {
  const { projectId } = useParams();
  const { notify } = useToast();
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
      publishProjectStateChanged(projectId);
      notify("Stack detection completed. Review the detected runtime and generate pre-flight when ready.", "success");
    } catch (caughtError) {
      setError(caughtError.message);
      notify(caughtError.message, "danger");
    } finally {
      setIsRunning(false);
    }
  }

  if (isLoading) {
    return <LoadingState message="Loading detection profile..." />;
  }

  return (
    <div className="grid">
      <PageHeader
        eyebrow="Detection & Pre-flight"
        title="Stack Detection & Pre-flight Validation"
        description="Understand the application runtime, select a safe container strategy, and validate the deployment contract before starting a pipeline."
        actions={
          canManage ? (
          <button
            className="secondary-button"
            disabled={isRunning}
            onClick={runDetection}
            type="button"
          >
            {isRunning ? "Detecting stack..." : profile ? "Run Stack Detection Again" : "Run Stack Detection"}
          </button>
          ) : null
        }
      />

      <ProjectModuleStatusStrip moduleKey="detection" projectId={projectId} />

      {error ? <ErrorState message={error} /> : null}
      {!profile && !error ? (
        <EmptyState message="No stack detection has run yet. Run detection to inspect repository manifests and create a deployment profile." />
      ) : null}
      {profile ? <DeploymentProfileCard profile={profile} /> : null}
      <PreflightPanel canManage={canManage} projectId={projectId} />
    </div>
  );
}
