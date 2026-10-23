import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import AppIcon from "../common/AppIcon.jsx";
import CommandPalette from "./CommandPalette.jsx";

function breadcrumbItems(pathname, projectId) {
  if (pathname.startsWith("/projects/") && projectId) {
    const page = pathname.split("/").filter(Boolean).at(-1);
    const label = page === projectId ? "Project Overview" : page === "logs" ? "Pipeline Events" : page?.replaceAll("-", " ");
    return ["Dashboard", "Projects", "Project", label];
  }

  if (pathname.startsWith("/projects")) return ["Dashboard", "Projects"];
  if (pathname.startsWith("/activity") || pathname.startsWith("/audit-logs")) return ["Dashboard", "Activity Log"];
  if (pathname.startsWith("/admin")) return ["Dashboard", "Admin"];
  return ["Dashboard"];
}

export default function Navbar() {
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

  return (
    <header className={isHidden ? "navbar is-hidden" : "navbar"}>
      <div>
        <nav className="breadcrumbs" aria-label="Breadcrumbs">
          {crumbs.map((crumb, index) => (
            <span key={`${crumb}-${index}`}>
            {index === 0 ? <Link to="/">{crumb}</Link> : crumb}
            </span>
          ))}
        </nav>
      </div>
      <div className="user-menu">
        <CommandPalette />
        <span aria-label="DeployGuard uses the light interface" className="shell-status"><AppIcon name="check" size={14} />Cloud delivery ready</span>
      </div>
    </header>
  );
}
