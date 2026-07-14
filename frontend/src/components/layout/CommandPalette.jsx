import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { getProjects } from "../../api/projectApi.js";
import { useAuth } from "../../hooks/useAuth.js";
import AppIcon from "../common/AppIcon.jsx";

export default function CommandPalette() {
  const { projectId } = useParams();
  const { role } = useAuth();
  const navigate = useNavigate();
  const inputRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [projects, setProjects] = useState([]);

  useEffect(() => {
    getProjects().then((response) => setProjects(response.projects || [])).catch(() => setProjects([]));
  }, []);

  useEffect(() => {
    function shortcut(event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
      }
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  const actions = useMemo(() => {
    const global = [
      { label: "Open Dashboard", hint: "Global overview", to: "/dashboard" },
      { label: "Open Projects", hint: "All workspaces", to: "/projects" },
    ];
    if (role !== "readonly") global.push({ label: "Create Project", hint: "New workspace", to: "/projects/new" });
    const contextual = projectId ? [
      { label: "Open Project Overview", hint: "Current workspace", to: `/projects/${projectId}` },
      { label: "Open Pipeline", hint: "Stages and recovery", to: `/projects/${projectId}/pipeline` },
      { label: "Open Settings", hint: "Project settings", to: `/projects/${projectId}/settings` },
    ] : [];
    const projectActions = projects.map((project) => ({ label: project.name, hint: project.repositoryFullName || "Project workspace", to: `/projects/${project.id}` }));
    return [...global, ...contextual, ...projectActions];
  }, [projectId, projects, role]);

  const filtered = actions.filter((action) => `${action.label} ${action.hint}`.toLowerCase().includes(query.toLowerCase())).slice(0, 12);

  function choose(action) {
    setOpen(false);
    navigate(action.to);
  }

  function handleKeyDown(event) {
    if (event.key === "ArrowDown") { event.preventDefault(); setSelected((current) => Math.min(current + 1, filtered.length - 1)); }
    if (event.key === "ArrowUp") { event.preventDefault(); setSelected((current) => Math.max(current - 1, 0)); }
    if (event.key === "Enter" && filtered[selected]) { event.preventDefault(); choose(filtered[selected]); }
  }

  return (
    <>
      <button aria-label="Open command palette" className="command-trigger" onClick={() => setOpen(true)} type="button"><AppIcon name="search" size={15} /><span>Search</span><kbd>⌘K</kbd></button>
      {open ? <div className="command-overlay" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}><section aria-label="Command palette" aria-modal="true" className="command-palette" role="dialog"><div className="command-input-row"><span aria-hidden="true">⌕</span><input aria-label="Search commands" onChange={(event) => { setQuery(event.target.value); setSelected(0); }} onKeyDown={handleKeyDown} placeholder="Search pages, projects, and actions" ref={inputRef} value={query} /><kbd>esc</kbd></div><div className="command-results" role="listbox">{filtered.map((action, index) => <button aria-selected={index === selected} className={index === selected ? "command-result selected" : "command-result"} key={`${action.label}-${action.to}`} onClick={() => choose(action)} onMouseEnter={() => setSelected(index)} role="option" type="button"><span>{action.label}</span><small>{action.hint}</small></button>)}{!filtered.length ? <p className="muted">No matching pages or projects.</p> : null}</div></section></div> : null}
    </>
  );
}
