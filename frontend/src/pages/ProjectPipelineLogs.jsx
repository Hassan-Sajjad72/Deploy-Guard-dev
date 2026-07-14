import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  getPipelineRun,
  getPipelineRunEvents,
  getPipelineRuns,
  getProject,
} from "../api/projectApi.js";
import EmptyState from "../components/common/EmptyState.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { PageHeader, StatusBadge } from "../components/common/Premium.jsx";
import PipelineLiveLogPanel from "../components/projects/PipelineLiveLogPanel.jsx";

export default function ProjectPipelineLogs() {
  const { projectId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [project, setProject] = useState(null);
  const [runs, setRuns] = useState([]);
  const [selectedRun, setSelectedRun] = useState(null);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  const shouldPoll = useMemo(
    () => ["queued", "running"].includes(selectedRun?.status),
    [selectedRun?.status]
  );

  useEffect(() => {
    loadPage();
  }, [projectId]);

  useEffect(() => {
    if (!shouldPoll || !selectedRun?.id) return undefined;
    const timer = window.setInterval(() => refreshRun(selectedRun.id), 4000);
    return () => window.clearInterval(timer);
  }, [projectId, selectedRun?.id, shouldPoll]);

  async function loadPage() {
    setIsLoading(true);
    setError("");
    try {
      const [projectResponse, runsResponse] = await Promise.all([
        getProject(projectId),
        getPipelineRuns(projectId),
      ]);
      const nextRuns = runsResponse.pipelineRuns || [];
      const requestedRunId = searchParams.get("run");
      const initialRun =
        nextRuns.find((run) => run.id === requestedRunId) || nextRuns[0] || null;
      setProject(projectResponse.project);
      setRuns(nextRuns);
      if (initialRun) await chooseRun(initialRun, false);
    } catch (caughtError) {
      setError(caughtError.message);
    } finally {
      setIsLoading(false);
    }
  }

  async function chooseRun(run, updateUrl = true) {
    setSelectedRun(run);
    if (updateUrl) setSearchParams({ run: run.id }, { replace: true });
    const response = await getPipelineRunEvents(projectId, run.id);
    setEvents(response.events || []);
  }

  async function refreshRun(runId) {
    try {
      const [runResponse, eventsResponse] = await Promise.all([
        getPipelineRun(projectId, runId),
        getPipelineRunEvents(projectId, runId),
      ]);
      setSelectedRun(runResponse.pipelineRun);
      setEvents(eventsResponse.events || []);
    } catch (caughtError) {
      setError(caughtError.message);
    }
  }

  if (isLoading) return <LoadingState message="Loading pipeline events…" />;
  if (error && !project) return <ErrorState message={error} />;

  return (
    <div className="workspace-page">
      <PageHeader
        eyebrow="Run evidence"
        title="Pipeline Events"
        description={`${project?.name || "Project"} structured worker lifecycle events. Raw worker stdout/stderr is not persisted, so this page does not claim to be a full log stream.`}
        actions={<Link className="secondary-button" to={`/projects/${projectId}/pipeline`}>View Pipeline</Link>}
      />
      {error ? <ErrorState message={error} /> : null}
      {!runs.length ? <EmptyState message="No pipeline events are available because no deployment run has started." /> : null}
      {runs.length ? <>
        <section className="panel-flat pipeline-event-context">
          <label className="field">
            <span>Deployment run</span>
            <select onChange={(event) => chooseRun(runs.find((run) => run.id === event.target.value))} value={selectedRun?.id || ""}>
              {runs.map((run, index) => <option key={run.id} value={run.id}>{index === 0 ? "Latest · " : ""}{run.id.slice(0, 8)} · {run.status}</option>)}
            </select>
          </label>
          <div><span className="muted">Run status</span><StatusBadge status={selectedRun?.status || "not_started"} /></div>
          <div><span className="muted">Current stage</span><strong>{selectedRun?.userFacingStageName || "Not started"}</strong></div>
        </section>
        <PipelineLiveLogPanel currentStage={selectedRun?.userFacingStageName} events={events} failedStage={selectedRun?.isFailed ? selectedRun.userFacingStageName : null} />
      </> : null}
    </div>
  );
}
