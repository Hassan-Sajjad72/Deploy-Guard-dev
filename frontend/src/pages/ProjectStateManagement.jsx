import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  clearStaleTerraformLockfile,
  forceReleaseTerraformLock,
  getProject,
  getTerraformState,
  getTerraformStateSafetySnapshot,
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
import StateSourcePanel from "../components/state/StateSourcePanel.jsx";
import { useProductMode } from "../hooks/useProductMode.js";

export default function ProjectStateManagement() {
  const { projectId } = useParams();
  const [project, setProject] = useState(null);
  const [state, setState] = useState(null);
  const [lock, setLock] = useState(null);
  const [queue, setQueue] = useState([]);
  const [s3Lockfile, setS3Lockfile] = useState(null);
  const [versions, setVersions] = useState([]);
  const [results, setResults] = useState([]);
  const [safety, setSafety] = useState(null);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const { isDeveloperMode } = useProductMode();

  useEffect(() => {
    load();
  }, [projectId]);

  async function load() {
    setError("");
    setIsLoading(true);

    try {
      const [projectResponse, stateResponse, locksResponse, versionsResponse, validationResponse, safetyResponse] =
        await Promise.all([
          getProject(projectId),
          getTerraformState(projectId),
          getTerraformStateLocks(projectId),
          getTerraformStateVersions(projectId),
          getTerraformStateValidation(projectId),
          getTerraformStateSafetySnapshot(projectId),
        ]);
      setProject(projectResponse.project);
      setState(stateResponse.state);
      setLock(locksResponse.lock);
      setQueue(locksResponse.queue || []);
      setS3Lockfile(locksResponse.s3Lockfile || null);
      setVersions(versionsResponse.versions || []);
      setResults(validationResponse.results || []);
      setSafety(safetyResponse.snapshot || null);
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

  async function clearStaleLockfile() {
    if (!s3Lockfile?.stale || !window.confirm(`Clear stale Terraform S3 lockfile?\n\n${s3Lockfile.key}\n\nOnly continue if no Terraform process is active.`)) return;
    try {
      await clearStaleTerraformLockfile(projectId);
      await load();
    } catch (caughtError) {
      setError(caughtError.message);
    }
  }

  if (isLoading) {
    return <LoadingState message="Loading Terraform state..." />;
  }
  const displayedState = state ? { ...state, status: safety?.stateStatus || state.status, currentVersionId: safety?.stateVersionId || state.currentVersionId, resourceCount: safety?.resourceCount ?? state.resourceCount } : state;
  const displayedLock = safety?.lockId ? { ...(lock || {}), lockId: safety.lockId, status: safety.lockStatus, heartbeatAt: safety.heartbeatAt, releasedAt: safety.releasedAt, pipelineRunId: safety.activePipelineRunId || lock?.pipelineRunId || null } : null;
  const forceReleaseAllowed = Boolean(project?.canManage && safety?.recoveryRequired && ["stale", "orphaned"].includes(safety?.lockStatus));

  return (
    <div className="grid">
      <PageHeader
        eyebrow="State Lock"
        title="Terraform State Safety"
        description={`${project?.name || "Project"} uses central S3 state with a project-specific native lockfile, plus DeployGuard job coordination and recovery.`}
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
        <StatusBadge status={safety?.lockStatus === "none" ? "no lock requested" : `lock ${safety?.lockStatus || "unknown"}`} tone={safety?.recoveryRequired ? "warning" : "neutral"} />
        <StatusBadge status={safety?.queueActive ? "state activity active" : "queue empty"} />
      </div>

      {error ? <ErrorState message={error} /> : null}
      {s3Lockfile?.exists || s3Lockfile?.error ? <section className={`state ${s3Lockfile?.stale ? "error" : "warning"}`} role="alert"><div><strong>S3 state lockfile recovery</strong><p>{s3Lockfile.error || (s3Lockfile.stale ? "Terraform S3 lockfile exists and may be stale." : "Terraform S3 lockfile is currently active.")}</p><code>{s3Lockfile.key}</code>{s3Lockfile.stale && project?.canManage ? <div className="button-row"><button className="danger-button" onClick={clearStaleLockfile} type="button">Clear stale S3 lockfile</button></div> : null}</div></section> : null}
      <OrphanedLockWarningBanner lock={lock} />
      <div className="grid two-column-grid">
        <TerraformStateStatusCard state={displayedState} />
        <StateLockStatusCard
          canForceRelease={forceReleaseAllowed}
          lock={displayedLock}
          onForceRelease={forceRelease}
        />
      </div>
      <DeploymentQueuePanel queue={queue} />
      <StateValidationResultsTable results={results} />
      <StateVersionsTable onRecover={recover} versions={versions} />
      {isDeveloperMode ? <StateSourcePanel snapshot={safety} /> : null}
    </div>
  );
}
