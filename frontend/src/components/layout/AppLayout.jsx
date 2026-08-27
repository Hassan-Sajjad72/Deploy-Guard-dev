import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { recordProjectView } from "../../api/projectApi.js";
import Navbar from "./Navbar.jsx";
import Sidebar from "./Sidebar.jsx";

export default function AppLayout() {
  const location = useLocation();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const selectedProjectId = location.pathname.match(/^\/projects\/([0-9a-f-]{36})(?:\/|$)/i)?.[1] || null;
  useEffect(() => {
    const match = location.pathname.match(/^\/projects\/([0-9a-f-]{36})(?:\/([^/]+))?/i);
    if (!match) return;
    const route = `${location.pathname}${location.search || ""}`;
    recordProjectView(match[1], route, match[2] || "overview").catch(() => undefined);
  }, [location.pathname, location.search]);
  useEffect(() => { setNavigationOpen(false); }, [location.pathname]);
  return (
    <div className="app-shell">
      <Sidebar isOpen={navigationOpen} onClose={() => setNavigationOpen(false)} projectId={selectedProjectId} />
      <div className="main-area">
        <Navbar navigationOpen={navigationOpen} onOpenNavigation={() => setNavigationOpen(true)} />
        <main className="content page-transition">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
