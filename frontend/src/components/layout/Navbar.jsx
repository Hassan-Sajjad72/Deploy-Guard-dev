import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import AppIcon from "../common/AppIcon.jsx";

function breadcrumbItems(pathname, projectId) {
  if (pathname.startsWith("/projects/") && projectId) {
    const page = pathname.split("/").filter(Boolean).at(-1);
    const labels = { infrastructure: "Infrastructure", monitoring: "Monitoring", pipeline: "Pipeline" };
    const label = page === projectId ? "Project Overview" : labels[page] || "Project";
    return [{ label: "Dashboard", to: "/dashboard" }, { label: "Projects", to: "/projects" }, { label }];
  }

  if (pathname === "/deploy") return [{ label: "Dashboard", to: "/dashboard" }, { label: "New Deployment" }];
  if (pathname.startsWith("/projects")) return [{ label: "Dashboard", to: "/dashboard" }, { label: "Projects" }];
  if (pathname.startsWith("/activity") || pathname.startsWith("/audit-logs")) return [{ label: "Dashboard", to: "/dashboard" }, { label: "Activity Log" }];
  if (pathname.startsWith("/admin")) return [{ label: "Admin" }];
  return [{ label: "Dashboard" }];
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
    <header className={isHidden ? "navbar glass-nav is-hidden" : "navbar glass-nav"}>
      <div className="navbar-leading">
        <button aria-controls="authenticated-navigation" aria-expanded={navigationOpen} aria-label="Open navigation" className="mobile-navigation-toggle" onClick={onOpenNavigation} type="button"><AppIcon name="menu" size={19} /></button>
        <nav className="breadcrumbs" aria-label="Breadcrumbs">
          {crumbs.map((crumb, index) => (
            <span aria-current={index === crumbs.length - 1 ? "page" : undefined} key={`${crumb.label}-${index}`}>
            {crumb.to ? <Link to={crumb.to}>{crumb.label}</Link> : crumb.label}
            </span>
          ))}
        </nav>
      </div>
      <div aria-hidden="true" className="user-menu" />
    </header>
  );
}
