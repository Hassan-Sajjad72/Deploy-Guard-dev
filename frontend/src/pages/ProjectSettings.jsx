import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { archiveProject, getProject, getProjectCurrentState } from "../api/projectApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { Button, Callout, Modal, PageHeader, Tabs } from "../components/common/DesignSystem.jsx";
import DestroyInfrastructure from "../components/projects/DestroyInfrastructure.jsx";
import NotificationSettingsPanel from "../components/projects/NotificationSettingsPanel.jsx";
import { redirectDeletedProject } from "../utils/projectStateSync.js";

const settingsSections = [
  { id: "notifications", label: "Notifications" },
  { id: "danger", label: "Danger zone" },
];

export default function ProjectSettings() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedSection = settingsSections.some((section) => section.id === searchParams.get("section")) ? searchParams.get("section") : "notifications";
  const [project, setProject] = useState(null);
  const [currentState, setCurrentState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmArchive, setConfirmArchive] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [{ project: value }, state] = await Promise.all([
        getProject(projectId),
        getProjectCurrentState(projectId).catch(() => null),
      ]);
      setProject(value);
      setCurrentState(state);
    } catch (caught) {
      if (!redirectDeletedProject(caught, navigate)) setError(caught.status === 403 ? "You do not have permission to view this project." : caught.message);
    } finally { setLoading(false); }
  }, [navigate, projectId]);

  useEffect(() => { void load(); }, [load]);

  async function archive() {
    setConfirmArchive(false); setBusy(true); setError("");
    try {
      await archiveProject(projectId);
      navigate("/projects", { state: { notice: `${project.name} was archived.` } });
    } catch (caught) { setError(caught.message); } finally { setBusy(false); }
  }

  if (loading) return <LoadingState message="Loading project settings…" />;
  if (!project) return <div className="page"><ErrorState message={error || "Project settings are unavailable."} onRetry={load} title="Settings could not be loaded" /><div className="actions"><Link className="btn" to="/projects">Back to projects</Link></div></div>;

  const canManage = Boolean(project.canManage);
  const panelProps = (id) => ({ "aria-labelledby": `project-settings-tab-${id}`, id: `project-settings-panel-${id}`, role: "tabpanel", tabIndex: 0, className: "settings-panel" });
  return <div className="page settings-page">
    <PageHeader description="SNS email notifications and project lifecycle actions." title="Settings" />
    <div className="settings-layout">
      <nav className="settings-nav"><Tabs activeId={requestedSection} idPrefix="project-settings" items={settingsSections} label="Project settings" onChange={(id) => { setError(""); setSearchParams(id === "notifications" ? {} : { section: id }, { replace: true }); }} /></nav>
      <div className="settings-content">
        {!canManage ? <Callout title="Read-only access" tone="info"><p>You can view this project and its history. Changing notification settings, archiving, and destroying infrastructure are limited to developers.</p></Callout> : null}
        {error ? <ErrorState message={error} title="The change was not saved" /> : null}
        {requestedSection === "notifications" ? <section {...panelProps("notifications")}><NotificationSettingsPanel canManage={canManage} projectId={projectId} /></section> : null}
        {requestedSection === "danger" ? <section {...panelProps("danger")}>
          <div className="section-head"><div><h2>Danger zone</h2><p>These actions affect your running app or remove the project from your lists.</p></div></div>
          <div className="panel danger-zone">
            <DestroyInfrastructure canManage={canManage} currentState={currentState} onDestroyed={load} projectId={projectId} />
            <div className="danger-row"><div><h3>Archive project</h3><p>Removes the project from your workspace lists. Deployment history is retained.</p></div><Button disabled={!canManage || busy} onClick={() => setConfirmArchive(true)} tone="danger">Archive project</Button></div>
          </div>
        </section> : null}
      </div>
    </div>
    {confirmArchive ? <Modal labelledBy="archive-title" onClose={() => setConfirmArchive(false)}><h2 id="archive-title">Archive {project.name}?</h2><p>It disappears from your project list. Deployment history is kept. Running infrastructure is not destroyed by archiving.</p><div className="dialog-actions"><Button onClick={() => setConfirmArchive(false)} tone="ghost">Cancel</Button><Button onClick={() => void archive()} tone="danger-solid">Archive project</Button></div></Modal> : null}
  </div>;
}
