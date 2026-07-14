import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getProject } from "../api/projectApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import {
  PageHeader,
} from "../components/common/Premium.jsx";
import ProjectDeployPanel from "../components/infrastructure/ProjectDeployPanel.jsx";
import ProjectModuleStatusStrip from "../components/projects/ProjectModuleStatusStrip.jsx";

export default function ProjectInfrastructure() {
  const { projectId } = useParams();
  const [project, setProject] = useState(null);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    setError("");
    setIsLoading(true);
    getProject(projectId)
      .then((response) => setProject(response.project))
      .catch((caughtError) => setError(caughtError.message))
      .finally(() => setIsLoading(false));
  }, [projectId]);

  if (isLoading) {
    return <LoadingState message="Loading infrastructure..." />;
  }

  if (error && !project) {
    return <ErrorState message={error} />;
  }

  return (
    <div className="grid">
      <PageHeader
        eyebrow="Infrastructure Gate"
        title="Terraform Infrastructure"
        description="VPC, subnets, NAT, ALB, security groups, Cloud Map, Terraform plan/apply status, and deployment readiness."
      />
      <ProjectModuleStatusStrip moduleKey="infrastructure" projectId={projectId} />
      {error ? <ErrorState message={error} /> : null}
      <ProjectDeployPanel
        canManage={Boolean(project?.canManage)}
        projectId={projectId}
      />
    </div>
  );
}
