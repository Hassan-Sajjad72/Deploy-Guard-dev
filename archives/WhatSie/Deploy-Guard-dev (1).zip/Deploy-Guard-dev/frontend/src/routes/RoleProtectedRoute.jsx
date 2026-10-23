import { Navigate, Outlet } from "react-router-dom";
import LoadingState from "../components/common/LoadingState.jsx";
import { useAuth } from "../hooks/useAuth.js";

export default function RoleProtectedRoute({ roles }) {
  const { isAuthenticated, isLoading, role } = useAuth();

  if (isLoading) {
    return <LoadingState message="Checking permissions..." />;
  }

  if (!isAuthenticated) {
    return <Navigate replace to="/login" />;
  }

  if (!roles.includes(role)) {
    return <Navigate replace to="/403" />;
  }

  return <Outlet />;
}
