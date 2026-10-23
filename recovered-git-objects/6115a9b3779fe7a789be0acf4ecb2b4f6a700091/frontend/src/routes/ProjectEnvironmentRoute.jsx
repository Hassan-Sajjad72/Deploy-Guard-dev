import { Navigate, useParams } from "react-router-dom";
import { useProductMode } from "../hooks/useProductMode.js";

export default function ProjectEnvironmentRoute({ children }) {
  const { projectId } = useParams();
  const { isDeveloperMode } = useProductMode();
  return isDeveloperMode ? children : <Navigate replace to={`/projects/${projectId}/requirements?focus=secrets`} />;
}
