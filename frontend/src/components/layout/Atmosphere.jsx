import { useLayoutEffect } from "react";
import { useLocation } from "react-router-dom";

/*
 * The environment behind every route: large diffused colour fields, mist and
 * grain. It is decorative only. The route picks the palette by setting
 * data-atmosphere on <html>; styles/aurora.css maps each name to its colours
 * and they cross-fade between pages.
 */
export function atmosphereForPath(pathname) {
  if (pathname === "/" || pathname === "/about") return "landing";
  if (pathname === "/deploy" || pathname.startsWith("/auth/")) return "onboarding";
  if (pathname === "/403") return "gate";
  if (pathname.startsWith("/admin")) return "admin";
  if (pathname === "/dashboard") return "home";
  if (pathname === "/billing") return "billing";
  if (pathname === "/projects") return "projects";
  const section = pathname.match(/^\/projects\/[^/]+(?:\/([^/]+))?/)?.[1];
  if (!section) return pathname.startsWith("/projects/") ? "project" : "home";
  return { pipeline: "pipeline", infrastructure: "infrastructure", monitoring: "monitoring", settings: "settings", troubleshooting: "troubleshoot" }[section] || "project";
}

export default function Atmosphere() {
  const { pathname } = useLocation();
  useLayoutEffect(() => { document.documentElement.dataset.atmosphere = atmosphereForPath(pathname); }, [pathname]);
  return <div aria-hidden="true" className="dg-atmos">
    <i className="dg-atmos-field is-a" />
    <i className="dg-atmos-field is-b" />
    <i className="dg-atmos-field is-c" />
    <i className="dg-atmos-field is-d" />
    <i className="dg-atmos-mist is-low" />
    <i className="dg-atmos-mist is-high" />
    <i className="dg-atmos-grain" />
  </div>;
}
