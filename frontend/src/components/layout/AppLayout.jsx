import { useEffect, useRef } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { recordProjectView } from "../../api/projectApi.js";
import AppHeader from "./AppHeader.jsx";

export default function AppLayout() {
  const location = useLocation();
  const mainRef = useRef(null);
  const firstRender = useRef(true);
  const selectedProjectId = location.pathname.match(/^\/projects\/([0-9a-f-]{36})(?:\/|$)/i)?.[1] || null;
  useEffect(() => {
    const match = location.pathname.match(/^\/projects\/([0-9a-f-]{36})(?:\/([^/]+))?/i);
    if (!match) return;
    const route = `${location.pathname}${location.search || ""}`;
    recordProjectView(match[1], route, match[2] || "overview").catch(() => undefined);
  }, [location.pathname, location.search]);
  // Move focus to the new page for keyboard and screen-reader users (not on first load).
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    mainRef.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [location.pathname]);
  return (
    <div className="app">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <AppHeader projectId={selectedProjectId} />
      <main className="app-main" id="main-content" ref={mainRef} tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
