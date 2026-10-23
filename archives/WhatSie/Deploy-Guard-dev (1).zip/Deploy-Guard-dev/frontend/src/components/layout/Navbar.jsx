import { useNavigate } from "react-router-dom";
import { useAuth } from "../../hooks/useAuth.js";

export default function Navbar() {
  const { logout, user } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <header className="navbar">
      <div>
        <strong>{user?.name || user?.email || "User"}</strong>
        <div className="muted">{user?.role || "unknown role"}</div>
      </div>
      <button className="secondary-button" onClick={handleLogout} type="button">
        Logout
      </button>
    </header>
  );
}
