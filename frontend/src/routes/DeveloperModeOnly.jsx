import { Navigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth.js";

export default function DeveloperModeOnly({ children }) {
  const { role } = useAuth();
  return role === "admin" ? children : <Navigate replace to="/403" />;
}
