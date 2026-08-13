import { Navigate, Outlet, useLocation } from "react-router-dom";
import LoadingState from "../components/common/LoadingState.jsx";
import { useAuth } from "../hooks/useAuth.js";

export default function ProtectedRoute() {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return <LoadingState message="Checking session..." />;
  }

  if (!isAuthenticated) {
    return <Navigate replace state={{ from: location }} to="/" />;
  }

  return <Outlet />;
}
