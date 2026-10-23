import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import AppIcon from "../common/AppIcon.jsx";
import CommandPalette from "./CommandPalette.jsx";

function breadcrumbItems(pathname, projectId) {
  if (pathname.startsWith("/projects/") && projectId) {
    const page = pathname.split("/").filter(Boolean).at(-1);
    const labels = { infrastructure: "Infrastructure", monitoring: "Monitoring", pipeline: "Pipeline", settings: "Settings", troubleshooting: "Troubleshoot" };
    const label = page === projectId ? "Overview" : labels[page] || "Project";
    return ["Projects", label];
  }
  if (pathname.startsWith("/deploy")) return ["Projects", "New deployment"];
  if (pathname.startsWith("/projects")) return ["Projects"];
  if (pathname.startsWith("/activity") || pathname.startsWith("/audit-logs")) return ["Activity"];
  if (pathname.startsWith("/admin")) return ["Admin"];
  return ["Workspace"];
}

export default function Navbar({ navigationOpen = false, onOpenNavigation }) {
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
      <div className="navbar-leading">
        <button aria-controls="authenticated-navigation" aria-expanded={navigationOpen} aria-label="Open navigation" className="mobile-navigation-toggle" onClick={onOpenNavigation} type="button"><AppIcon name="menu" size={19} /></button>
        <nav className="breadcrumbs" aria-label="Breadcrumbs">
          <Link className="breadcrumb-home" to="/projects"><span className="breadcrumb-mark" />DeployGuard</Link>
          {crumbs.map((crumb, index) => <span className="breadcrumb-segment" key={`${crumb}-${index}`}><span aria-hidden="true" className="breadcrumb-divider">/</span>{crumb}</span>)}
        </nav>
      </div>
      <div className="user-menu">
        <span className="navbar-live-indicator"><span />Platform ready</span>
        <CommandPalette />
        <span aria-label="GitHub Actions is DeployGuard's delivery engine" className="shell-context"><AppIcon name="pipeline" size={14} />GitHub Actions delivery</span>
      </div>
    </header>
  );
}
