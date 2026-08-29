import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getProjectDetailedCurrentState } from "../api/projectApi.js";
import { Card, PageHeader, StatusChip } from "../components/common/DesignSystem.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { subscribeProjectStateChanged } from "../utils/projectStateSync.js";
import { projectStatePresentation } from "../utils/projectStatePresentation.js";

export default function ProjectInfrastructure() {
  const { projectId } = useParams();
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setError(""); setState(await getProjectDetailedCurrentState(projectId)); }
    catch (caught) { setError(caught.message); }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => subscribeProjectStateChanged(projectId, load), [load, projectId]);
  useEffect(() => {
    if (!projectStatePresentation(state).active) return undefined;
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, [state?.stateAuthority?.activeOperation?.id, state?.stateAuthority?.activeOperation?.status, load]);
  if (!state && !error) return <LoadingState message="Loading infrastructure state…" />;
  const infrastructure = state?.stateAuthority?.infrastructure;
  const attempt = state?.latestAttempt;
  const absent = infrastructure?.exists === false || infrastructure?.status === "not_provisioned";
  const provisioningFailed = infrastructure?.status === "provisioning_failed";
  const identity = state?.infrastructureEvidence?.runtimeIdentity || {};
  const observation = state?.infrastructureEvidence;
  const value = (entry) => entry || "Unavailable";
  const resources = [
    ["Region", identity.region], ["Generation", state?.generationState?.liveGenerationId], ["Source SHA", state?.stableRelease?.commit],
    ["Immutable image", identity.imageDigest ? `${identity.imageUri}@${identity.imageDigest}` : identity.imageUri],
    ["ECS cluster", identity.ecsClusterArn || identity.ecsClusterName], ["ECS service", identity.ecsServiceArn || identity.ecsServiceName],
    ["Task definition", identity.taskDefinitionArn], ["ALB", identity.albArn || identity.albName], ["Target group", identity.targetGroupArn || identity.targetGroupName],
    ["Public endpoint", identity.publicUrl || state?.stableUrl], ["CloudWatch log group", identity.cloudWatchLogGroupName], ["Terraform state key", identity.terraformStateKey],
    ["EFS file system", identity.databaseEfsFileSystemId], ["EFS access point", identity.databaseEfsAccessPointId],
  ];
  return <div className="workspace-page">
    <PageHeader eyebrow="Infrastructure" title="Runtime infrastructure" status={infrastructure?.status || "unavailable"} description="Only authoritative runtime resources from the current deployment generation are shown." />
    {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}
    {absent ? <Card><p className="eyebrow">Runtime infrastructure not provisioned</p><h2>Deployment stopped during {state?.progress?.phase === "build" ? "Railpack Build" : "dispatch before runtime provisioning"}.</h2><p>No runtime infrastructure was provisioned for this attempt.</p><p>Deployment attempt {attempt?.attempt || "unavailable"} · {attempt?.workflowRunId ? `GitHub Actions run ${attempt.workflowRunId} failed before runtime provisioning.` : "GitHub Actions run was not created."}</p><Link className="button secondary-button" to={`/projects/${projectId}/pipeline`}>Open Pipeline evidence</Link></Card> : provisioningFailed ? <Card><p className="eyebrow">Provisioning failed</p><h2>Runtime provisioning did not complete.</h2><StatusChip status="failed">Provisioning failed</StatusChip><p>Some project resources may have been created before Terraform stopped. Open Pipeline for technical evidence.</p><Link className="button secondary-button" to={`/projects/${projectId}/pipeline`}>Open Pipeline evidence</Link></Card> : <><Card><p className="eyebrow">Persisted verified identity</p><h2>Authoritative LIVE runtime</h2><StatusChip status={infrastructure?.status || "unavailable"}>{infrastructure?.status || "Unavailable"}</StatusChip><div className="troubleshooting-operation-grid">{resources.map(([label, entry]) => <article key={label}><span>{label}</span><strong>{value(entry)}</strong></article>)}</div></Card><Card><p className="eyebrow">Current AWS observation</p><h2>{observation?.freshness === "current" ? "Fresh runtime evidence" : "Live observation unavailable"}</h2><p>Source: {value(observation?.source)} · Observed: {value(observation?.lastUpdatedAt)}</p><div className="troubleshooting-operation-grid"><article><span>ECS tasks</span><strong>{observation?.ecs ? `${observation.ecs.runningCount}/${observation.ecs.desiredCount} running · ${observation.ecs.pendingCount} pending` : "Unavailable"}</strong></article><article><span>ALB target health</span><strong>{observation?.alb?.targetHealth?.length ? observation.alb.targetHealth.join(", ") : "Unavailable"}</strong></article></div></Card></>}
  </div>;
}
