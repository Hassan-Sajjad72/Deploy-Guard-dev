import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getOrchestrationReleases } from "../api/projectApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import ReleasesTable from "../components/orchestration/ReleasesTable.jsx";

export default function ProjectReleases() {
  const { projectId } = useParams();
  const [releases, setReleases] = useState([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const response = await getOrchestrationReleases(projectId);
        setReleases(response.releases || []);
      } catch (caughtError) {
        setError(caughtError.message);
      } finally {
        setIsLoading(false);
      }
    }

    load();
  }, [projectId]);

  if (isLoading) return <LoadingState message="Loading releases..." />;

  return (
    <div className="grid">
      <div className="page-header">
        <div>
          <h1>Stable Releases</h1>
          <p className="muted">Deployments that reached ECS stability and ALB health.</p>
        </div>
        <Link className="secondary-button" to={`/projects/${projectId}/orchestration`}>
          Orchestration
        </Link>
      </div>
      {error ? <ErrorState message={error} /> : null}
      <ReleasesTable releases={releases} />
    </div>
  );
}
