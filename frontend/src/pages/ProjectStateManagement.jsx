import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  forceReleaseTerraformLock,
  getProject,
  getTerraformState,
  getTerraformStateLocks,
  getTerraformStateValidation,
  getTerraformStateVersions,
  recoverTerraformState,
  validateTerraformState,
} from "../api/projectApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { PageHeader, StatusBadge } from "../components/common/Premium.jsx";
import DeploymentQueuePanel from "../components/state/DeploymentQueuePanel.jsx";
import OrphanedLockWarningBanner from "../components/state/OrphanedLockWarningBanner.jsx";
import StateLockStatusCard from "../components/state/StateLockStatusCard.jsx";
import StateValidationResultsTable from "../components/state/StateValidationResultsTable.jsx";
import StateVersionsTable from "../components/state/StateVersionsTable.jsx";
import TerraformStateStatusCard from "../components/state/TerraformStateStatusCard.jsx";
import ProjectModuleStatusStrip from "../components/projects/ProjectModuleStatusStrip.jsx";

export default function ProjectStateManagement() {
  const { projectId } = useParams();
  const [project, setProject] = useState(null);
  const [state, setState] = useState(null);
  const [lock, setLock] = useState(null);
  const [queue, setQueue] = useState([]);
  const [versions, setVersions] = useState([]);
  const [results, setResults] = useState([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    load();
  }, [projectId]);

  async function load() {
    setError("");
    setIsLoading(true);

    try {
      const [projectResponse, stateResponse, locksResponse, versionsResponse, validationResponse] =
        await Promise.all([
          getProject(projectId),
          getTerraformState(projectId),
          getTerraformStateLocks(projectId),
          getTerraformStateVersions(projectId),
          getTerraformStateValidation(projectId),
        ]);
      setProject(projectResponse.project);
      setState(stateResponse.state);
      setLock(locksResponse.lock);
      setQueue(locksResponse.queue || []);
      setVersions(versionsResponse.versions || []);
      setResults(validationResponse.results || []);
    } catch (caughtError) {
      setError(caughtError.message);
    } finally {
      setIsLoading(false);
    }
  }

  async function validate() {
    try {
      await validateTerraformState(projectId);
      await load();
    } catch (caughtError) {
      setError(caughtError.message);
    }
  }

  async function recover(versionId) {
    if (!window.confirm("Recover Terraform state from this previous version? Review the selected version before continuing.")) return;
    try {
      await recoverTerraformState(projectId, versionId, "Restore previous valid state.");
      await load();
    } catch (caughtError) {
      setError(caughtError.message);
    }
  }

  async function forceRelease(lockId) {
    if (!window.confirm("Force release this Terraform state lock? Only continue if the owning job is no longer active.")) return;
    try {
      await forceReleaseTerraformLock(projectId, lockId);
      await load();
    } catch (caughtError) {
      setError(caughtError.message);
    }
  }

  if (isLoading) {
    return <LoadingState message="Loading Terraform state..." />;
  }

  return (
    <div className="grid">
      <PageHeader
        eyebrow="State Lock"
        title="Terraform State Safety"
        description={`${project?.name || "Project"} remote state mode, lock ownership, validation, recovery, and queued jobs.`}
        actions={
          <>
          {project?.canManage ? (
            <button className="button" onClick={validate} type="button">
              Validate State
            </button>
          ) : null}
          </>
        }
      />

      <ProjectModuleStatusStrip moduleKey="state" projectId={projectId} />
      <div className="button-row">
        <StatusBadge status={lock ? "lock active" : "no lock requested"} tone={lock ? "warning" : "neutral"} />
        <StatusBadge status={queue.length ? "jobs queued" : "queue empty"} />
      </div>

      {error ? <ErrorState message={error} /> : null}
      <OrphanedLockWarningBanner lock={lock} />
      <div className="grid two-column-grid">
        <TerraformStateStatusCard state={state} />
        <StateLockStatusCard
          canForceRelease={Boolean(project?.canManage)}
          lock={lock}
          onForceRelease={forceRelease}
        />
      </div>
      <DeploymentQueuePanel queue={queue} />
      <StateValidationResultsTable results={results} />
      <StateVersionsTable onRecover={recover} versions={versions} />
    </div>
  );
}
