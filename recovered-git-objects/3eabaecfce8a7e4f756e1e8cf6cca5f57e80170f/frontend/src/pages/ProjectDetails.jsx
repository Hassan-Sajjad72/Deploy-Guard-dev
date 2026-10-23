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

const ACTIVE = new Set(["preparing", "queued", "building", "deploying", "verifying"]);

function date(value) {
  return value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
    : "—";
}

export default function ProjectDetails() {
  const { projectId } = useParams();
  const { role } = useAuth();
  const { notify } = useToast();
  const inFlight = useRef(false);
  const [project, setProject] = useState(null);
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    try {
      const [projectResponse, current] = await Promise.all([
        getProject(projectId),
        getProjectCurrentState(projectId),
      ]);
      setProject(projectResponse.project);
      setState(current);
      setError("");
    } catch (caught) {
      setError(caught.message);
    }
  }

  useEffect(() => { load(); }, [projectId]);
  useEffect(() => {
    if (!ACTIVE.has(state?.developerState)) return undefined;
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, [state?.developerState, projectId]);

  async function deploy() {
    if (inFlight.current || !["deploy", "redeploy"].includes(state?.developerAction)) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const message = await executeNormalReleaseAction(projectId, state);
      await load();
      if (message) notify(message, "success");
    } catch (caught) {
      setError(caught.message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (!project || !state) return <div className="workspace-page">{error ? <ErrorState message={error} onRetry={load} /> : <LoadingState message="Loading project…" />}</div>;

  const canManage = role === "admin" || role === "developer";
  const progress = Number(state.progress?.percentage || 0);
  const action = state.developerAction;
  return <div className="workspace-page project-overview-page">
    <header className="project-page-header"><div className="project-title-lockup"><span className="project-glyph project-glyph-large"><AppIcon name="box" size={21} /></span><div><div className="project-title-row"><h1>{project.name}</h1><StatusBadge status={state.developerState} /></div><p>{state.repository || project.repositoryFullName} <span>·</span> {state.branch || project.targetBranch}</p></div></div></header>
    {error ? <ErrorState message={error} onRetry={load} /> : null}
    <div className="project-control-layout"><main className="project-control-main">
      <section className={`deployment-canvas panel-flat ${["failed_application", "platform_attention"].includes(state.developerState) ? "deployment-canvas-failed" : ""}`}>
        <div className="deployment-canvas-header"><div><p className="eyebrow">Current deployment</p><div className="deployment-stage-title"><span className={ACTIVE.has(state.developerState) ? "active-stage-beacon" : ""} /><h2>{state.progress?.label || "Ready"}</h2></div><p>{state.developerMessage}</p></div><div className="deployment-progress-value"><strong>{progress}%</strong><span>{state.developerState.replaceAll("_", " ")}</span></div></div>
        <div className="deployment-progress-track"><span style={{ width: `${progress}%` }} /></div>
        <dl className="deployment-run-summary"><div><dt>Commit</dt><dd>{state.commit?.slice(0, 12) || "Not analyzed"}</dd></div><div><dt>Latest attempt</dt><dd>{state.latestAttempt ? `Release ${state.latestAttempt.releaseRevision || "—"}` : "None"}</dd></div><div><dt>Last activity</dt><dd>{date(state.latestAttempt?.occurredAt)}</dd></div><div><dt>Stable release</dt><dd>{state.stableRelease ? `Release ${state.stableRelease.revision}` : "None"}</dd></div></dl>
        <div className="simple-primary-actions">
          {["deploy", "redeploy"].includes(action) && canManage ? <button className="button" disabled={busy} onClick={deploy} type="button">{busy ? "Working…" : action === "redeploy" ? "Redeploy" : "Deploy"}</button> : null}
          {action === "provide_configuration" ? <Link className="button" to={`/projects/${projectId}/requirements`}>Provide Configuration</Link> : null}
          {action === "approve_cost" ? <Link className="button" to="/billing">Approve Cost</Link> : null}
          {action === "open_application" && state.stableUrl ? <a className="button" href={state.stableUrl} rel="noreferrer" target="_blank">Open Application</a> : null}
        </div>
      </section>
      {state.applicationError ? <section className="panel-flat state warning"><div><strong>Application action required</strong><p>{state.applicationError.message}</p></div></section> : null}
    </main><aside className="project-control-aside">
      <section className="project-live-card panel-flat"><p className="eyebrow">Stable release</p><h2>{state.stableRelease ? `Release ${state.stableRelease.revision}` : "No stable release"}</h2><p>{state.stableRelease ? `${state.stableRelease.commit.slice(0, 12)} · promoted ${date(state.stableRelease.promotedAt)}` : "A verified live URL appears only after a stable release."}</p>{state.stableUrl ? <a className="secondary-button" href={state.stableUrl} rel="noreferrer" target="_blank">Open Application</a> : null}</section>
      {state.missingConfiguration.length ? <section className="panel-flat"><p className="eyebrow">Required configuration</p><h2>{state.missingConfiguration.length} value{state.missingConfiguration.length === 1 ? "" : "s"} needed</h2><p>{state.missingConfiguration.join(", ")}</p></section> : null}
    </aside></div>
  </div>;
}
