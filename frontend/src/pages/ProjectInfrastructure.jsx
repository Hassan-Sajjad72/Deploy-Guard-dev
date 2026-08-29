import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getProjectCurrentState } from "../api/projectApi.js";
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
    try { setError(""); setState(await getProjectCurrentState(projectId)); }
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
  return <div className="workspace-page">
    <PageHeader eyebrow="Infrastructure" title="Runtime infrastructure" status={infrastructure?.status || "unavailable"} description="Only authoritative runtime resources from the current deployment generation are shown." />
    {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}
    {absent ? <Card><p className="eyebrow">Runtime infrastructure not provisioned</p><h2>Deployment stopped during {state?.progress?.phase === "build" ? "Railpack Build" : "dispatch before runtime provisioning"}.</h2><p>No runtime infrastructure was provisioned for this attempt.</p><p>Deployment attempt {attempt?.attempt || "unavailable"} · {attempt?.workflowRunId ? `GitHub Actions run ${attempt.workflowRunId} failed before runtime provisioning.` : "GitHub Actions run was not created."}</p><Link className="button secondary-button" to={`/projects/${projectId}/pipeline`}>Open Pipeline evidence</Link></Card> : provisioningFailed ? <Card><p className="eyebrow">Provisioning failed</p><h2>Runtime provisioning did not complete.</h2><StatusChip status="failed">Provisioning failed</StatusChip><p>Some project resources may have been created before Terraform stopped. Open Pipeline for technical evidence.</p><Link className="button secondary-button" to={`/projects/${projectId}/pipeline`}>Open Pipeline evidence</Link></Card> : <Card><p className="eyebrow">Infrastructure evidence</p><h2>{infrastructure?.exists ? "Runtime resources are recorded" : "Infrastructure evidence unavailable"}</h2><StatusChip status={infrastructure?.status || "unavailable"}>{infrastructure?.status || "Unavailable"}</StatusChip><p>{infrastructure?.exists ? "Current runtime resource evidence is available." : "No authoritative infrastructure resource manifest is available."}</p></Card>}
  </div>;
}
