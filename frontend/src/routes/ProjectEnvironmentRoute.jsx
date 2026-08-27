import { Navigate, useParams } from "react-router-dom";

export default function ProjectEnvironmentRoute() {
  const { projectId } = useParams();
  return <Navigate replace to={`/projects/${projectId}/requirements`} />;
}
