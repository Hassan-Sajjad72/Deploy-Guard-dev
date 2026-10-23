import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getProjectCurrentState, getProjects } from "../api/projectApi.js";
import AppIcon from "../components/common/AppIcon.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { CollapsiblePanel, RecentActivityTimeline, StatusBadge, formatStatus } from "../components/common/Premium.jsx";
import { useAuth } from "../hooks/useAuth.js";

function deploymentLabel(state) {
  if (!state) return "State unavailable";
  if (state.liveDeployment?.available) return "Live";
  if (["queued", "running"].includes(state.latestPipeline?.status)) return state.currentStepLabel;
  if (["failed", "blocked"].includes(state.overallStatus)) return "Needs attention";
  return state.currentStepLabel || formatStatus(state.overallStatus);
}

export default function Dashboard() {
  const { role } = useAuth();
  const [summaries, setSummaries] = useState([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const response = await getProjects();
        const projects = response.projects || [];
        const states = await Promise.allSettled(projects.map((project) => getProjectCurrentState(project.id)));
        if (mounted) {
          setSummaries(projects.map((project, index) => ({
            project,
            currentState: states[index].status === "fulfilled" ? states[index].value : null,
          })));
          setError("");
        }
      } catch (caughtError) {
        if (mounted) setError(caughtError.message);
      } finally {
        if (mounted) setIsLoading(false);
      }
    }
    load();
    const timer = window.setInterval(load, 8000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, []);

  const workspace = useMemo(() => {
    const known = summaries.filter(({ currentState }) => currentState);
    const active = known.filter(({ currentState }) => ["queued", "running"].includes(currentState.latestPipeline?.status));
    const live = known.filter(({ currentState }) => currentState.liveDeployment?.available);
    const attention = known.filter(({ currentState }) => ["blocked", "failed"].includes(currentState.overallStatus));
    const continueProject = active[0] || attention[0] || known[0] || summaries[0] || null;
    return { known, active, live, attention, continueProject };
  }, [summaries]);

  const activity = workspace.known
    .flatMap(({ currentState }) => currentState.recentActivity || [])
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 5);
  const environment = workspace.known[0]?.currentState?.environmentModes;

  return (
    <div className="workspace-page dashboard-page">
      <header className="workspace-heading">
        <div><p className="eyebrow">Workspace</p><h1>Your deployments</h1><p>Monitor releases, recover failures, and open running applications.</p></div>
        {summaries.length && role !== "readonly" ? <Link className="button" to="/projects/new"><AppIcon name="plus" size={16} />New project</Link> : null}
      </header>

      {error ? <ErrorState message={error} /> : null}
      {isLoading ? <LoadingState message="Loading your deployments…" /> : null}

      {!isLoading && !summaries.length && !error ? (
        <section className="workspace-empty-state">
          <div className="empty-orbit" aria-hidden="true"><AppIcon name="deploy" size={28} /></div>
          <p className="eyebrow">No deployments yet</p>
          <h2>Connect your first repository</h2>
          <p>DeployGuard will detect, prepare, build, scan, and deploy through every enabled stage.</p>
          {role !== "readonly" ? <Link className="button" to="/projects/new"><AppIcon name="plus" size={16} />Create project</Link> : null}
        </section>
      ) : null}

      {!isLoading && summaries.length ? <>
        <section className="workspace-stat-strip" aria-label="Workspace summary">
          <div><span>Projects</span><strong>{summaries.length}</strong></div>
          <div><span>Active runs</span><strong className={workspace.active.length ? "text-info" : ""}>{workspace.active.length}</strong></div>
          <div><span>Live</span><strong className={workspace.live.length ? "text-success" : ""}>{workspace.live.length}</strong></div>
          <div><span>Needs attention</span><strong className={workspace.attention.length ? "text-danger" : ""}>{workspace.attention.length}</strong></div>
        </section>

        <div className="dashboard-focus-grid">
          {workspace.continueProject ? <Link className="continue-deployment-card" to={`/projects/${workspace.continueProject.project.id}`}>
            <div className="deployment-card-top"><span className="project-glyph"><AppIcon name="box" size={18} /></span><StatusBadge status={workspace.continueProject.currentState?.overallStatus || "unknown"} /></div>
            <div><p className="eyebrow">Continue where you left off</p><h2>{workspace.continueProject.project.name}</h2><p>{workspace.continueProject.currentState?.userFacingStatus || "Open this project to refresh deployment state."}</p></div>
            <div className="continue-progress"><div><span>{deploymentLabel(workspace.continueProject.currentState)}</span><strong>{workspace.continueProject.currentState?.progressPercentage ?? 0}%</strong></div><div className="progress-track"><span style={{ width: `${workspace.continueProject.currentState?.progressPercentage ?? 0}%` }} /></div></div>
            <span className="card-link-label">Open project <AppIcon name="arrow" size={15} /></span>
          </Link> : null}

          <section className="active-runs-card panel-flat">
            <div className="compact-section-heading"><div><p className="eyebrow">Automation</p><h2>Active runs</h2></div><span className="count-chip">{workspace.active.length}</span></div>
            <div className="active-run-list">
              {workspace.active.slice(0, 4).map(({ project, currentState }) => <Link key={project.id} to={`/projects/${project.id}/pipeline`}><span className="run-status-ring" /><span><strong>{project.name}</strong><small>{currentState.currentStepLabel}</small></span><span className="run-percentage">{currentState.progressPercentage}%</span></Link>)}
              {!workspace.active.length ? <div className="calm-empty"><span className="success-check"><AppIcon name="check" size={15} /></span><div><strong>No active runs</strong><p>Queued and running deployments will appear here.</p></div></div> : null}
            </div>
          </section>
        </div>

        <div className="dashboard-content-grid">
          <section className="projects-list-panel panel-flat">
            <div className="compact-section-heading"><div><p className="eyebrow">Projects</p><h2>Recent projects</h2></div><Link className="text-link" to="/projects">View all <AppIcon name="arrow" size={14} /></Link></div>
            <div className="project-deployment-list">
              {summaries.slice(0, 6).map(({ project, currentState }) => <Link key={project.id} to={`/projects/${project.id}`}>
                <span className="project-glyph"><AppIcon name="box" size={17} /></span>
                <span className="project-list-identity"><strong>{project.name}</strong><small>{project.repositoryFullName || project.repositoryUrl} · {project.targetBranch || "No branch"}</small></span>
                <span className="project-list-stage"><small>Current stage</small><strong>{deploymentLabel(currentState)}</strong></span>
                <span className="project-list-progress"><span><i style={{ width: `${currentState?.progressPercentage ?? 0}%` }} /></span><small>{currentState?.progressPercentage ?? 0}%</small></span>
                <StatusBadge status={currentState?.overallStatus || "unknown"} />
                <AppIcon className="row-arrow" name="chevron" size={16} />
              </Link>)}
            </div>
          </section>

          <section className="activity-panel panel-flat">
            <div className="compact-section-heading"><div><p className="eyebrow">Workspace activity</p><h2>Recent events</h2></div></div>
            <RecentActivityTimeline activity={activity} />
          </section>
        </div>

        {environment ? <CollapsiblePanel summary="Developer details"><dl className="developer-detail-grid"><div><dt>Terraform Apply</dt><dd>{environment.terraformApplyEnabled ? "Enabled" : "Disabled"}</dd></div><div><dt>FinOps source</dt><dd>{environment.finopsMockMode ? "Mock" : "Real"}</dd></div><div><dt>State backend</dt><dd>{environment.stateMockMode ? "Mock" : "Remote"}</dd></div><div><dt>External CI</dt><dd>{environment.githubActionsRequired ? "Required" : "Optional"}</dd></div></dl></CollapsiblePanel> : null}
      </> : null}
    </div>
  );
}
