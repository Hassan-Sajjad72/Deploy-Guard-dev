import { Navigate, Outlet, useLocation } from "react-router-dom";
import LoadingState from "../components/common/LoadingState.jsx";
import { useAuth } from "../hooks/useAuth.js";

export default function RoleProtectedRoute({ roles }) {
  const { isAuthenticated, isLoading, role } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return <LoadingState message="Checking permissions..." />;
  }

  if (!isAuthenticated) {
    return <Navigate replace state={{ from: location }} to="/" />;
  }

  if (!roles.includes(role)) {
    return <Navigate replace to="/403" />;
  }

  return <Outlet />;
}
