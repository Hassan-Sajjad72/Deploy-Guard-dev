import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../../hooks/useAuth.js";
import { useTheme } from "../../hooks/useTheme.js";
import AppIcon from "../common/AppIcon.jsx";
import CommandPalette from "./CommandPalette.jsx";

function breadcrumbItems(pathname, projectId) {
  if (pathname.startsWith("/projects/") && projectId) {
    const page = pathname.split("/").filter(Boolean).at(-1);
    const label = page === projectId ? "Project Overview" : page?.replaceAll("-", " ");
    return ["Dashboard", "Projects", "Project", label];
  }

  if (pathname.startsWith("/projects")) return ["Dashboard", "Projects"];
  if (pathname.startsWith("/audit-logs")) return ["Dashboard", "Activity"];
  if (pathname.startsWith("/admin")) return ["Dashboard", "Admin"];
  return ["Dashboard"];
}

export default function Navbar() {
  const { logout, user } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const { projectId } = useParams();
  const crumbs = breadcrumbItems(location.pathname, projectId);
  const [isHidden, setIsHidden] = useState(false);

  useEffect(() => {
    let lastY = window.scrollY;

    function handleScroll() {
      const nextY = window.scrollY;
      setIsHidden(nextY > 120 && nextY > lastY);
      lastY = nextY;
    }

    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  async function handleLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <header className={isHidden ? "navbar is-hidden" : "navbar"}>
      <div>
        <nav className="breadcrumbs" aria-label="Breadcrumbs">
          {crumbs.map((crumb, index) => (
            <span key={`${crumb}-${index}`}>
              {index === 0 ? <Link to="/dashboard">{crumb}</Link> : crumb}
            </span>
          ))}
        </nav>
      </div>
      <div className="user-menu">
        <CommandPalette />
        <button aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} className="icon-button" onClick={toggleTheme} title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} type="button">
          <AppIcon name={theme === "dark" ? "sun" : "moon"} size={17} />
        </button>
        <div className="user-chip">
          <span className="user-avatar">{String(user?.name || user?.email || "U").charAt(0).toUpperCase()}</span>
          <span><strong>{user?.name || user?.email || "User"}</strong><small>{user?.role || "member"}</small></span>
        </div>
        <button aria-label="Log out" className="icon-button" onClick={handleLogout} title="Log out" type="button">
          <AppIcon name="arrow" size={17} />
        </button>
      </div>
    </header>
  );
}
