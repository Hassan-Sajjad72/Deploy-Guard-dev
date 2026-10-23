import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getProject, getProjectCurrentState } from "../api/projectApi.js";
import AppIcon from "../components/common/AppIcon.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { StatusBadge } from "../components/common/Premium.jsx";
import { useAuth } from "../hooks/useAuth.js";
import { useToast } from "../hooks/useToast.js";
import { executeNormalReleaseAction } from "../utils/normalReleaseAction.js";

const PHASES = ["Analyze", "Build", "Prepare", "Deploy", "Verify"];
const ACTIVE = new Set(["preparing", "queued", "building", "deploying", "verifying"]);

export default function ProjectPipeline() {
  const { projectId } = useParams();
  const { role } = useAuth();
  const { notify } = useToast();
  const inFlight = useRef(false);
  const [project, setProject] = useState(null);
  const [current, setCurrent] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    try {
      const [projectResponse, state] = await Promise.all([getProject(projectId), getProjectCurrentState(projectId)]);
      setProject(projectResponse.project);
      setCurrent(state);
      setError("");
    } catch (caught) { setError(caught.message); }
  }

  useEffect(() => { load(); }, [projectId]);
  useEffect(() => {
    if (!ACTIVE.has(current?.developerState)) return undefined;
    const timer = window.setInterval(load, 4000);
    return () => window.clearInterval(timer);
  }, [current?.developerState, projectId]);

  async function deploy() {
    if (inFlight.current || !["deploy", "redeploy", "approve_cost"].includes(current?.developerAction)) return;
    inFlight.current = true; setBusy(true); setError("");
    try { const message = await executeNormalReleaseAction(projectId, current); await load(); if (message) notify(message, "success"); }
    catch (caught) { setError(caught.message); }
    finally { inFlight.current = false; setBusy(false); }
  }

  if (!project || !current) return <div className="workspace-page">{error ? <ErrorState message={error} onRetry={load} /> : <LoadingState message="Loading deployments…" />}</div>;
  const phaseIndex = Math.max(0, PHASES.findIndex((phase) => phase.toLowerCase() === current.progress?.phase));
  const canManage = role === "admin" || role === "developer";
  return <div className="workspace-page project-pipeline-page">
    <header className="project-page-header"><div className="project-title-lockup"><span className="project-glyph project-glyph-large"><AppIcon name="pipeline" size={21} /></span><div><div className="project-title-row"><h1>Deployments</h1><StatusBadge status={current.developerState} /></div><p>{project.name} <span>·</span> {current.branch || project.targetBranch} {current.latestAttempt ? <><span>·</span> Release {current.latestAttempt.releaseRevision || "—"}</> : null}</p></div></div></header>
    {error ? <ErrorState message={error} onRetry={load} /> : null}
    <section className="panel-flat"><div className="compact-section-heading"><div><p className="eyebrow">Latest attempt</p><h2>{current.developerMessage}</h2></div><StatusBadge status={current.developerState} /></div><div className="deployment-progress-track"><span style={{ width: `${current.progress?.percentage || 0}%` }} /></div><div className="release-operation-phases">{PHASES.map((phase, index) => <div className={index < phaseIndex ? "passed" : index === phaseIndex && ACTIVE.has(current.developerState) ? "running" : "not_started"} key={phase}><span /> <strong>{phase}</strong></div>)}</div><div className="simple-primary-actions">{["deploy", "redeploy"].includes(current.developerAction) && canManage ? <button className="button" disabled={busy} onClick={deploy} type="button">{busy ? "Working…" : current.developerAction === "redeploy" ? "Redeploy" : "Deploy"}</button> : null}{current.developerAction === "provide_configuration" ? <Link className="button" to={`/projects/${projectId}/requirements`}>Provide Configuration</Link> : null}{current.developerAction === "approve_cost" && canManage ? <button className="button" disabled={busy} onClick={deploy} type="button">{busy ? "Working…" : "Approve Cost"}</button> : null}{current.developerAction === "open_application" && current.stableUrl ? <a className="button" href={current.stableUrl} rel="noreferrer" target="_blank">Open Application</a> : null}</div></section>
    <section className="panel-flat"><p className="eyebrow">Stable release</p><h2>{current.stableRelease ? `Release ${current.stableRelease.revision}` : "No verified stable release"}</h2><p>{current.stableRelease ? `Commit ${current.stableRelease.commit.slice(0, 12)}` : "The latest attempt remains separate from stable release evidence."}</p>{current.stableUrl ? <a className="secondary-button" href={current.stableUrl} rel="noreferrer" target="_blank">Open Application</a> : null}</section>
  </div>;
}
