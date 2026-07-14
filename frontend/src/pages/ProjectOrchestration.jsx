import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  deployOrchestration,
  getOrchestrationEvents,
  getOrchestrationStatus,
  rollbackOrchestration,
  updateOrchestrationScaling,
} from "../api/projectApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import {
  BentoGrid,
  MetricCard,
  PageHeader,
  StatusBadge,
} from "../components/common/Premium.jsx";
import AlbHealthStatusCard from "../components/orchestration/AlbHealthStatusCard.jsx";
import AutoScalingPolicyCard from "../components/orchestration/AutoScalingPolicyCard.jsx";
import DeploymentUrlCard from "../components/orchestration/DeploymentUrlCard.jsx";
import EcsDeploymentStatusCard from "../components/orchestration/EcsDeploymentStatusCard.jsx";
import FargateSpotStatusCard from "../components/orchestration/FargateSpotStatusCard.jsx";
import OrchestrationEventsTimeline from "../components/orchestration/OrchestrationEventsTimeline.jsx";
import RollbackPanel from "../components/orchestration/RollbackPanel.jsx";
import SpotInterruptionEventsTable from "../components/orchestration/SpotInterruptionEventsTable.jsx";
import StableReleaseCard from "../components/orchestration/StableReleaseCard.jsx";
import ProjectModuleStatusStrip from "../components/projects/ProjectModuleStatusStrip.jsx";

export default function ProjectOrchestration() {
  const { projectId } = useParams();
  const [status, setStatus] = useState(null);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isDeploying, setIsDeploying] = useState(false);

  useEffect(() => {
    loadPage();
  }, [projectId]);

  async function loadPage() {
    setError("");
    setIsLoading(true);

    try {
      const [statusResponse, eventsResponse] = await Promise.all([
        getOrchestrationStatus(projectId),
        getOrchestrationEvents(projectId),
      ]);
      setStatus(statusResponse);
      setEvents(eventsResponse.events || []);
    } catch (caughtError) {
      setError(caughtError.message);
    } finally {
      setIsLoading(false);
    }
  }

  async function deploy() {
    setError("");
    setIsDeploying(true);

    try {
      await deployOrchestration(projectId);
      await loadPage();
    } catch (caughtError) {
      setError(caughtError.message);
    } finally {
      setIsDeploying(false);
    }
  }

  async function rollback(reason) {
    setError("");

    try {
      await rollbackOrchestration(projectId, reason);
      await loadPage();
    } catch (caughtError) {
      setError(caughtError.message);
    }
  }

  async function updateScaling(data) {
    setError("");

    try {
      await updateOrchestrationScaling(projectId, data);
      await loadPage();
    } catch (caughtError) {
      setError(caughtError.message);
    }
  }

  if (isLoading) {
    return <LoadingState message="Loading orchestration..." />;
  }

  return (
    <div className="grid">
      <PageHeader
        eyebrow="Orchestration"
        title="ECS Release Control"
        description="ECS Fargate Spot deployment, ALB health, stable release state, autoscaling, and rollback controls."
        actions={
          <>
          <button className="button" disabled={isDeploying || !status?.canManage} onClick={deploy} type="button">
            {isDeploying ? "Queued" : "Deploy to ECS"}
          </button>
          </>
        }
      />

      <ProjectModuleStatusStrip moduleKey="orchestration" projectId={projectId} />

      {error ? <ErrorState message={error} /> : null}

      <BentoGrid>
        <MetricCard
          label="ECS Service"
          value={status?.deployment?.serviceName || "-"}
          detail={status?.deployment?.clusterName || "Cluster not reported"}
        />
        <MetricCard
          label="Rollout State"
          value={status?.deployment?.rolloutState || status?.deployment?.status || "-"}
          detail="Never treated as stable unless backend confirms ECS and ALB health"
        />
        <MetricCard
          label="Target Health"
          value={status?.targetHealth?.status || status?.targetHealth?.overallStatus || "-"}
          detail={<StatusBadge status={status?.targetHealth?.status || status?.targetHealth?.overallStatus || "unknown"} />}
        />
        <MetricCard
          label="Rollback Candidate"
          value={status?.stableRelease?.imageTag || status?.stableRelease?.shortCommitSha || "-"}
          detail="Previous stable release is used by rollback workflow"
        />
      </BentoGrid>

      <EcsDeploymentStatusCard deployment={status?.deployment} />
      <DeploymentUrlCard deployment={status?.deployment} />
      <StableReleaseCard release={status?.stableRelease} />
      <AlbHealthStatusCard targetHealth={status?.targetHealth} />
      <FargateSpotStatusCard scaling={status?.scaling} />
      <AutoScalingPolicyCard
        canManage={Boolean(status?.canManage)}
        onUpdate={updateScaling}
        scaling={status?.scaling}
      />
      <RollbackPanel
        canManage={Boolean(status?.canManage)}
        hasRelease={Boolean(status?.stableRelease)}
        onRollback={rollback}
      />
      <SpotInterruptionEventsTable events={status?.spotEvents || []} />
      <OrchestrationEventsTimeline events={events} />
    </div>
  );
}
