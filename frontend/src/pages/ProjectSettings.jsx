import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { archiveProject, getProject, getProjectBranches, getProjectDatabaseTier, updateProject, updateProjectBranch, updateProjectDatabaseTier, updateProjectRepository } from "../api/projectApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { PageHeader } from "../components/common/Premium.jsx";
import EnvironmentVariablesPanel from "../components/projects/EnvironmentVariablesPanel.jsx";

export default function ProjectSettings() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState(null);
  const [branches, setBranches] = useState([]);
  const [form, setForm] = useState({ name: "", description: "", visibility: "private", repositoryUrl: "", targetBranch: "main" });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [database, setDatabase] = useState({ provider: "none", engine: "postgres", persistenceEnabled: true });

  async function load() {
    setLoading(true); setError("");
    try {
      const [{ project: value }, databaseResponse] = await Promise.all([getProject(projectId), getProjectDatabaseTier(projectId)]);
      setProject(value);
      setForm({
        name: value.name || "", description: value.description || "", visibility: value.visibility || "private",
        repositoryUrl: value.repositoryUrl || "", targetBranch: value.targetBranch || "main",
      });
      setDatabase({ provider: databaseResponse.database?.provider || "none", engine: databaseResponse.database?.engine || "postgres", persistenceEnabled: databaseResponse.database?.persistenceEnabled !== false });
    } catch (caught) {
      setError(caught.status === 404 ? "Project not found." : caught.status === 403 ? "You do not have permission to view this project." : caught.message);
    } finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [projectId]);
  function change(event) { setForm((current) => ({ ...current, [event.target.name]: event.target.value })); }
  async function action(work, message) {
    setBusy(true); setError(""); setSuccess("");
    try { await work(); setSuccess(message); } catch (caught) { setError(caught.message); } finally { setBusy(false); }
  }
  async function saveDetails(event) {
    event.preventDefault();
    await action(async () => {
      const response = await updateProject(projectId, { name: form.name, description: form.description, visibility: form.visibility });
      setProject(response.project);
    }, "Project details saved.");
  }
  async function saveRepository(event) {
    event.preventDefault();
    await action(async () => {
      await updateProjectRepository(projectId, { repositoryUrl: form.repositoryUrl });
      const response = await getProjectBranches(projectId);
      setBranches(response.branches || []);
    }, "Repository connected and branches loaded.");
  }
  async function loadBranches() { await action(async () => { const response = await getProjectBranches(projectId); setBranches(response.branches || []); }, "Branches loaded."); }
  async function saveBranch() { await action(async () => { await updateProjectBranch(projectId, form.targetBranch); setProject((current) => ({ ...current, targetBranch: form.targetBranch })); }, "Deployment branch updated."); }
  async function archive() { if (!window.confirm("Archive this project?")) return; await action(async () => { await archiveProject(projectId); navigate("/projects"); }, "Project archived."); }
  async function saveDatabase(event) {
    event.preventDefault();
    await action(async () => {
      const response = await updateProjectDatabaseTier(projectId, database);
      setDatabase({ provider: response.database?.provider || "none", engine: response.database?.engine || "postgres", persistenceEnabled: response.database?.persistenceEnabled !== false });
    }, database.provider === "managed" ? "Managed database settings saved." : "Managed database disabled.");
  }

  if (loading) return <div className="workspace-page"><LoadingState message="Loading project settings…" /></div>;
  if (!project) return <div className="workspace-page"><ErrorState message={error || "Project settings are unavailable."} onRetry={load} /><Link className="secondary-button" to="/projects">Back to Projects</Link></div>;

  return <div className="workspace-page">
    <PageHeader eyebrow="Application" title="Settings" description="Manage project identity, repository, and branch." context={`${project.repositoryFullName} · ${project.targetBranch}`} />
    {error ? <ErrorState message={error} /> : null}{success ? <div className="state success">{success}</div> : null}
    <div className="settings-restored-grid">
      <form className="panel-flat settings-simple-form" onSubmit={saveDetails}><div><p className="eyebrow">Project</p><h2>Project details</h2></div><label className="field"><span>Name</span><input disabled={!project.canManage || busy} name="name" onChange={change} required value={form.name} /></label><label className="field"><span>Description</span><input disabled={!project.canManage || busy} name="description" onChange={change} value={form.description} /></label><label className="field"><span>Visibility</span><select disabled={!project.canManage || busy} name="visibility" onChange={change} value={form.visibility}><option value="private">Private</option><option value="workspace">Workspace</option></select></label>{project.canManage ? <button className="button" disabled={busy} type="submit">Save project details</button> : null}</form>
      <form className="panel-flat settings-simple-form" onSubmit={saveRepository}><div><p className="eyebrow">Source</p><h2>Repository and branch</h2><p className="muted">Private repository access uses your encrypted credential.</p></div><label className="field"><span>Repository URL</span><input disabled={!project.canManage || busy} name="repositoryUrl" onChange={change} value={form.repositoryUrl} /></label>{project.canManage ? <button className="secondary-button" disabled={busy} type="submit">Update repository</button> : null}<label className="field"><span>Deployment branch</span>{branches.length ? <select disabled={!project.canManage || busy} name="targetBranch" onChange={change} value={form.targetBranch}>{branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}</select> : <input disabled={!project.canManage || busy} name="targetBranch" onChange={change} value={form.targetBranch} />}</label>{project.canManage ? <div className="quick-actions"><button className="subtle-button" disabled={busy} onClick={loadBranches} type="button">Load branches</button><button className="secondary-button" disabled={busy} onClick={saveBranch} type="button">Save branch</button></div> : null}</form>
    </div>
    <EnvironmentVariablesPanel canManage={Boolean(project.canManage)} projectId={projectId} />
    <form className="panel-flat settings-simple-form" onSubmit={saveDatabase}><div><p className="eyebrow">Data</p><h2>Managed database</h2><p className="muted">Optional container database with encrypted persistent storage. Connection values are injected at runtime.</p></div><label className="field"><span>Database</span><select disabled={!project.canManage || busy} onChange={(event) => setDatabase((current) => ({ ...current, provider: event.target.value }))} value={database.provider}><option value="none">Disabled</option><option value="managed">Enabled</option></select></label>{database.provider === "managed" ? <><label className="field"><span>Engine</span><select disabled={!project.canManage || busy} onChange={(event) => setDatabase((current) => ({ ...current, engine: event.target.value }))} value={database.engine}><option value="postgres">PostgreSQL</option><option value="mysql">MySQL</option><option value="mongodb">MongoDB</option></select></label><label className="checkbox-row"><input checked={database.persistenceEnabled} disabled={!project.canManage || busy} onChange={(event) => setDatabase((current) => ({ ...current, persistenceEnabled: event.target.checked }))} type="checkbox" />Persist database data</label></> : null}{project.canManage ? <button className="button" disabled={busy} type="submit">Save database settings</button> : null}</form>
    {project.canManage ? <section className="panel-flat danger-zone"><div><h2>Archive project</h2><p>Remove it from active workspace lists while retaining history.</p></div><button className="danger-text-button" disabled={busy} onClick={archive} type="button">Archive project</button></section> : null}
  </div>;
}
