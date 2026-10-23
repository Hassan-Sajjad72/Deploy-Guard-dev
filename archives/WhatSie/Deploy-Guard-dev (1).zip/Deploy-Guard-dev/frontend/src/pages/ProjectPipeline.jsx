import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  getPipelineRun,
  getPipelineRunEvents,
  getPipelineRuns,
  getProject,
  startPipelineRun,
} from "../api/projectApi.js";
import EmptyState from "../components/common/EmptyState.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import PipelineRunPanel from "../components/projects/PipelineRunPanel.jsx";
import PipelineRunsTable from "../components/projects/PipelineRunsTable.jsx";
import StartPipelineForm from "../components/projects/StartPipelineForm.jsx";

const ACTIVE_STATUSES = ["queued", "running"];

export default function ProjectPipeline() {
  const { projectId } = useParams();
  const [project, setProject] = useState(null);
  const [runs, setRuns] = useState([]);
  const [selectedRun, setSelectedRun] = useState(null);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isStarting, setIsStarting] = useState(false);
  const [options, setOptions] = useState({
    triggerGithubActions: false,
    buildImage: true,
    pushToEcr: false,
  });

  const shouldPoll = useMemo(
    () => Boolean(selectedRun && ACTIVE_STATUSES.includes(selectedRun.status)),
    [selectedRun]
  );

  useEffect(() => {
    loadPage();
  }, [projectId]);

  useEffect(() => {
    if (!shouldPoll) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      refreshSelectedRun(selectedRun.id);
    }, 4000);

    return () => window.clearInterval(timer);
  }, [projectId, selectedRun?.id, shouldPoll]);

  async function loadPage() {
    setError("");
    setIsLoading(true);

    try {
      const [projectResponse, runsResponse] = await Promise.all([
        getProject(projectId),
        getPipelineRuns(projectId),
      ]);
      const nextRuns = runsResponse.pipelineRuns || [];

      setProject(projectResponse.project);
      setRuns(nextRuns);

      if (nextRuns[0]) {
        await selectRun(nextRuns[0]);
      }
    } catch (caughtError) {
      setError(caughtError.message);
    } finally {
      setIsLoading(false);
    }
  }

  async function loadRuns(selectedRunId) {
    const response = await getPipelineRuns(projectId);
    const nextRuns = response.pipelineRuns || [];
    setRuns(nextRuns);

    if (selectedRunId) {
      const matchingRun = nextRuns.find((run) => run.id === selectedRunId);
      if (matchingRun) {
        setSelectedRun(matchingRun);
      }
    }

    return nextRuns;
  }

  async function selectRun(run) {
    setSelectedRun(run);
    const response = await getPipelineRunEvents(projectId, run.id);
    setEvents(response.events || []);
  }

  async function refreshSelectedRun(runId) {
    try {
      const [runResponse, eventsResponse] = await Promise.all([
        getPipelineRun(projectId, runId),
        getPipelineRunEvents(projectId, runId),
      ]);
      setSelectedRun(runResponse.pipelineRun);
      setEvents(eventsResponse.events || []);
      await loadRuns(runId);
    } catch (caughtError) {
      setError(caughtError.message);
    }
  }

  async function startRun() {
    setError("");
    setIsStarting(true);

    try {
      const response = await startPipelineRun(projectId, options);
      const queuedRun = response.pipelineRun;
      await loadRuns(queuedRun.id);
      await selectRun(queuedRun);
    } catch (caughtError) {
      setError(caughtError.message);
    } finally {
      setIsStarting(false);
    }
  }

  if (isLoading) {
    return <LoadingState message="Loading pipeline..." />;
  }

  if (error && !project) {
    return <ErrorState message={error} />;
  }

  return (
    <div className="grid">
      <div className="page-header">
        <div>
          <h1>CI/CD Pipeline</h1>
          <p className="muted">{project?.name || "Project"} deployment runs.</p>
        </div>
        <div className="quick-actions">
          <Link className="secondary-button" to={`/projects/${projectId}`}>
            Project Details
          </Link>
          <Link className="secondary-button" to={`/projects/${projectId}/preflight`}>
            Pre-Flight
          </Link>
          <Link className="secondary-button" to={`/projects/${projectId}/security`}>
            Security Scans
          </Link>
        </div>
      </div>

      {error ? <ErrorState message={error} /> : null}

      <StartPipelineForm
        canManage={Boolean(project?.canManage)}
        isStarting={isStarting}
        onStart={startRun}
        options={options}
        setOptions={setOptions}
      />

      {runs.length === 0 ? (
        <EmptyState message="No pipeline runs have been queued yet." />
      ) : null}

      <PipelineRunsTable
        onSelect={selectRun}
        runs={runs}
        selectedRunId={selectedRun?.id}
      />

      <PipelineRunPanel
        events={events}
        projectId={projectId}
        selectedRun={selectedRun}
      />
    </div>
  );
}
