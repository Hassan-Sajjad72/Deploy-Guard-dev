import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { getWorkspaceSummary } from "../api/projectApi.js";
import AppIcon from "../components/common/AppIcon.jsx";
import { Button, Callout, EmptyState, PageHeader, Status } from "../components/common/DesignSystem.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import Time from "../components/common/Time.jsx";
import { useAuth } from "../hooks/useAuth.js";
import { normalReleaseView } from "../utils/normalReleaseView.js";
import { conciseProjectSummary } from "../utils/overviewLifecyclePresentation.js";
import { liveWithFailedLatest, projectStateLabel, projectStatePresentation, projectStateTone } from "../utils/projectStatePresentation.js";
import { productText } from "../utils/productTerms.js";

const filters = [
  ["ALL", "All"],
  ["ATTENTION", "Needs attention"],
  ["DEPLOYING", "Deploying"],
  ["LIVE", "Live"],
  ["DESTROYED", "Destroyed"],
];

/** One short line that explains why a project needs attention. */
function attentionReason(currentState) {
  if (liveWithFailedLatest(currentState)) return "Last deployment failed. The previous release is still live.";
  const diagnosis = currentState?.latestAttempt?.diagnosis;
  return productText(diagnosis?.summary) || conciseProjectSummary(currentState);
}

/*
 * The workspace home: one project list. Projects that need attention or are
 * deploying sort first and carry their reason or progress inline, so nothing
 * is listed twice.
 */
export default function Projects() {
  const { role } = useAuth();
  const location = useLocation();
  const [summaries, setSummaries] = useState([]);
  const [attentionIds, setAttentionIds] = useState(() => new Set());
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [stateFilter, setStateFilter] = useState("ALL");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await getWorkspaceSummary();
      setSummaries(response.summaries || []);
      setAttentionIds(new Set((response.needsAttention || []).map(({ project }) => project?.id)));
      setError("");
    } catch (caught) {
      setError(caught.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    window.addEventListener("focus", load);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", load);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const rows = useMemo(() => summaries.map((summary) => {
    const presentation = projectStatePresentation(summary.currentState);
    const attention = attentionIds.has(summary.project.id) || presentation.state === "FAILED";
    const rank = attention ? 0 : presentation.active ? 1 : 2;
    return { ...summary, presentation, attention, rank };
  }).sort((left, right) => left.rank - right.rank), [attentionIds, summaries]);

  const hasActiveOperation = rows.some(({ presentation }) => presentation.active);
  useEffect(() => {
    if (!hasActiveOperation) return undefined;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 8000);
    return () => window.clearInterval(timer);
  }, [hasActiveOperation, load]);

  const counts = useMemo(() => rows.reduce((totals, { presentation, attention }) => {
    const next = { ...totals, [presentation.state]: (totals[presentation.state] || 0) + 1 };
    if (attention) next.ATTENTION = (next.ATTENTION || 0) + 1;
    return next;
  }, { ALL: rows.length }), [rows]);

  const visible = useMemo(() => rows.filter(({ project, currentState, presentation, attention }) => {
    const matchesState = stateFilter === "ALL" || (stateFilter === "ATTENTION" ? attention : presentation.state === stateFilter);
    const haystack = `${project.name} ${currentState?.repository || project.repositoryFullName || ""} ${currentState?.branch || project.targetBranch || ""}`.toLowerCase();
    return matchesState && haystack.includes(search.trim().toLowerCase());
  }), [rows, search, stateFilter]);

  const summaryLine = [
    counts.ATTENTION ? `${counts.ATTENTION} need${counts.ATTENTION === 1 ? "s" : ""} attention` : null,
    counts.DEPLOYING ? `${counts.DEPLOYING} deploying` : null,
    counts.LIVE ? `${counts.LIVE} live` : null,
  ].filter(Boolean).join(" · ");
  const canDeploy = role !== "readonly";

  return <div className="page projects-page">
    <PageHeader
      actions={canDeploy && rows.length ? <Button icon="plus" to="/deploy" tone="primary">New deployment</Button> : null}
      description={loading ? "Loading your projects…" : rows.length ? summaryLine || `${rows.length} project${rows.length === 1 ? "" : "s"}` : "Repositories you deploy with DeployGuard."}
      title="Projects"
    />
    {location.state?.notice ? <Callout tone="success">{location.state.notice}</Callout> : null}
    {error ? <ErrorState message={error} onRetry={() => void load()} title="Projects could not be loaded" /> : null}
    {loading ? <LoadingState inline message="Loading projects…" /> : null}
    {!loading && !error && !rows.length ? <EmptyState
      action={canDeploy ? <Button icon="github" to="/deploy" tone="primary">Deploy a repository</Button> : null}
      icon="deploy"
      message={canDeploy ? "Pick a GitHub repository and branch. DeployGuard builds it, runs it on AWS and tells you when something needs attention." : "No projects have been shared with you yet."}
      title="No projects yet"
    /> : null}
    {!loading && !error && rows.length ? <section aria-label="Projects" className="section">
      {rows.length > 3 ? <div className="projects-toolbar">
        <label className="search projects-search"><span className="sr-only">Search projects</span><AppIcon name="search" size={16} /><input autoComplete="off" className="input" name="project-search" onChange={(event) => setSearch(event.target.value)} placeholder="Search by name, repository or branch" spellCheck={false} type="search" value={search} /></label>
        <div aria-label="Filter by state" className="segmented" role="group">
          {filters.filter(([value]) => value === "ALL" || counts[value]).map(([value, label]) => <button aria-pressed={stateFilter === value} key={value} onClick={() => setStateFilter(value)} type="button">{label}<span className="count">{counts[value] || 0}</span></button>)}
        </div>
      </div> : null}
      {!visible.length ? <p className="muted projects-none">No projects match. <button className="btn-link btn" onClick={() => { setSearch(""); setStateFilter("ALL"); }} type="button">Clear filters</button></p> : <ul className="rows projects-list">
        {visible.map(({ project, currentState, presentation, attention }) => {
          const activity = project.activity?.lastMeaningfulActivityAt || currentState?.latestAttempt?.occurredAt || project.createdAt;
          const repository = currentState?.repository || project.repositoryFullName;
          const branch = currentState?.branch || project.targetBranch;
          const release = presentation.active ? normalReleaseView(currentState) : null;
          const degraded = liveWithFailedLatest(currentState);
          const tone = presentation.state === "FAILED" ? "danger" : projectStateTone(presentation.state);
          return <li data-authoritative-state={presentation.state} key={project.id}>
            <Link className={`project-row${attention ? " is-attention" : ""}`} to={presentation.active ? `/projects/${project.id}/pipeline` : `/projects/${project.id}`}>
              <span className="project-state"><Status active={presentation.active} tone={tone}>{projectStateLabel(presentation.state)}</Status></span>
              <span className="project-identity">
                <strong translate="no">{project.name}</strong>
                <span className="project-source" translate="no">{repository ? <span className="truncate" title={repository}>{repository}</span> : null}{branch ? <span className="project-branch truncate" title={branch}><AppIcon name="branch" size={13} /><span>{branch}</span></span> : null}</span>
              </span>
              <span className="project-detail">
                {attention ? <span className={degraded ? "project-reason is-warn" : "project-reason is-bad"}>{attentionReason(currentState)}</span> : null}
                {release ? <span className="project-progress"><span aria-hidden="true" className="meter tone-info"><i style={{ width: `${release.progress ?? 0}%` }} /></span><span>{currentState?.progress?.label || "Preparing"}</span></span> : null}
              </span>
              <span className="project-time muted"><Time value={activity} /></span>
              <AppIcon className="project-chevron" name="chevron" size={16} />
            </Link>
          </li>;
        })}
      </ul>}
    </section> : null}
  </div>;
}
