import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { archiveProject, createProjectService, deleteProjectService, getProject, getProjectBranches, getProjectDatabaseTier, updateProject, updateProjectBranch, updateProjectDatabaseTier, updateProjectRepository, updateProjectService } from "../api/projectApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { PageHeader } from "../components/common/Premium.jsx";
import { Tabs } from "../components/common/DesignSystem.jsx";
import EnvironmentVariablesPanel from "../components/projects/EnvironmentVariablesPanel.jsx";
import NotificationSettingsPanel from "../components/projects/NotificationSettingsPanel.jsx";

const settingsSections = [
  { id: "general", label: "General" },
  { id: "source", label: "Source" },
  { id: "services", label: "Services" },
  { id: "variables", label: "Variables" },
  { id: "database", label: "Database" },
  { id: "notifications", label: "Notifications" },
  { id: "danger", label: "Danger Zone" },
];

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
  const [services, setServices] = useState([]);
  const [applicationEntryPointServiceId, setApplicationEntryPointServiceId] = useState("");
  const [activeSection, setActiveSection] = useState("general");
  const [selectedServiceId, setSelectedServiceId] = useState("");

  async function load() {
    setLoading(true); setError("");
    try {
      const [{ project: value }, databaseResponse] = await Promise.all([getProject(projectId), getProjectDatabaseTier(projectId)]);
      setProject(value);
      setServices(value.services || []);
      setSelectedServiceId((current) => current || value.services?.[0]?.id || "");
      setApplicationEntryPointServiceId(value.applicationEntryPointServiceId || "");
      setForm({
        name: value.name || "", description: value.description || "", visibility: value.visibility || "private",
        repositoryUrl: value.repositoryUrl || "", targetBranch: value.targetBranch || "main",
      });
      setDatabase({ provider: databaseResponse.database?.provider || "none", engine: databaseResponse.database?.engine || "postgres", persistenceEnabled: databaseResponse.database?.persistenceEnabled !== false, attachedServiceId: databaseResponse.database?.attachedServiceId || value.services?.[0]?.id || "" });
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
      setDatabase({ provider: response.database?.provider || "none", engine: response.database?.engine || "postgres", persistenceEnabled: response.database?.persistenceEnabled !== false, attachedServiceId: response.database?.attachedServiceId || services[0]?.id || "" });
    }, database.provider === "managed" ? "Managed database settings saved." : "Managed database disabled.");
  }
  async function addService() { await action(async () => { const response = await createProjectService(projectId, { name: `Service ${services.length + 1}`, serviceDirectory: "." }); setServices((current) => [...current, response.service]); setSelectedServiceId(response.service.id); }, "Service added."); }
  async function saveService(service) { await action(async () => { const response = await updateProjectService(projectId, service.id, { name: service.name, serviceDirectory: service.serviceDirectory }); setServices((current) => current.map((item) => item.id === service.id ? response.service : item)); }, `${service.name} saved.`); }
  async function saveApplicationService(event) { event.preventDefault(); await action(async () => { const response = await updateProject(projectId, { applicationEntryPointServiceId }); setProject(response.project); setApplicationEntryPointServiceId(response.project.applicationEntryPointServiceId || ""); }, "Application service saved."); }
  async function removeService(service) { if (!window.confirm(`Remove ${service.name}? Its service-scoped environment values will also be removed.`)) return; await action(async () => { await deleteProjectService(projectId, service.id); setServices((current) => { const next = current.filter((item) => item.id !== service.id); setSelectedServiceId((selected) => selected === service.id ? next[0]?.id || "" : selected); return next; }); }, "Service removed."); }

  if (loading) return <div className="workspace-page"><LoadingState message="Loading project settings…" /></div>;
  if (!project) return <div className="workspace-page"><ErrorState message={error || "Project settings are unavailable."} onRetry={load} /><Link className="secondary-button" to="/projects">Back to Projects</Link></div>;

  const selectedService = services.find((service) => service.id === selectedServiceId) || services[0];
  return <div className="workspace-page project-settings-page">
    <PageHeader eyebrow="Project" title="Settings" description="Configure this project by category." context={`${project.repositoryFullName} · ${project.targetBranch}`} />
    <Tabs activeId={activeSection} idPrefix="project-settings" items={settingsSections} label="Project settings" onChange={setActiveSection} />
    {error ? <ErrorState message={error} /> : null}{success ? <div className="state success">{success}</div> : null}

    {activeSection === "general" ? <form aria-labelledby="project-settings-tab-general" className="panel-flat operational-surface settings-simple-form settings-section-panel" id="project-settings-panel-general" onSubmit={saveDetails} role="tabpanel"><div><p className="eyebrow">General</p><h2>Project details</h2></div><label className="field"><span>Name</span><input disabled={!project.canManage || busy} name="name" onChange={change} required value={form.name} /></label><label className="field"><span>Description</span><input disabled={!project.canManage || busy} name="description" onChange={change} value={form.description} /></label><label className="field"><span>Visibility</span><select disabled={!project.canManage || busy} name="visibility" onChange={change} value={form.visibility}><option value="private">Private</option><option value="workspace">Workspace</option></select></label>{project.canManage ? <button className="button" disabled={busy} type="submit">Save changes</button> : null}</form> : null}

    {activeSection === "source" ? <form aria-labelledby="project-settings-tab-source" className="panel-flat operational-surface settings-simple-form settings-section-panel" id="project-settings-panel-source" onSubmit={saveRepository} role="tabpanel"><div><p className="eyebrow">Source</p><h2>Repository and branch</h2><p className="muted">Private repository access uses your encrypted credential.</p></div><label className="field"><span>Repository URL</span><input disabled={!project.canManage || busy} name="repositoryUrl" onChange={change} value={form.repositoryUrl} /></label>{project.canManage ? <button className="secondary-button" disabled={busy} type="submit">Save repository</button> : null}<label className="field"><span>Deployment branch</span>{branches.length ? <select disabled={!project.canManage || busy} name="targetBranch" onChange={change} value={form.targetBranch}>{branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}</select> : <input disabled={!project.canManage || busy} name="targetBranch" onChange={change} value={form.targetBranch} />}</label>{project.canManage ? <div className="quick-actions"><button className="subtle-button" disabled={busy} onClick={loadBranches} type="button">Load branches</button><button className="secondary-button" disabled={busy} onClick={saveBranch} type="button">Save branch</button></div> : null}</form> : null}

    {activeSection === "services" ? <section aria-labelledby="project-settings-tab-services" className="panel-flat operational-surface settings-section-panel" id="project-settings-panel-services" role="tabpanel"><div className="compact-section-heading"><div><p className="eyebrow">Services</p><h2>Deployable applications</h2><p className="muted">Each service directory is configured explicitly; its application port is detected automatically.</p></div>{project.canManage ? <button className="secondary-button" disabled={busy} onClick={addService} type="button">+ Add service</button> : null}</div>{services.length > 1 ? <form className="settings-entrypoint-form" onSubmit={saveApplicationService}><label className="field"><span>Open Application service</span><select disabled={!project.canManage || busy} onChange={(event) => setApplicationEntryPointServiceId(event.target.value)} required value={applicationEntryPointServiceId}><option value="">Choose a service</option>{services.map((service) => <option key={service.id} value={service.id}>{service.name} — {service.serviceDirectory}</option>)}</select></label>{project.canManage ? <button className="secondary-button" disabled={busy || !applicationEntryPointServiceId} type="submit">Save entrypoint</button> : null}</form> : <p className="muted">{services[0]?.name || "The only service"} is the application entrypoint.</p>}<div className="settings-service-list">{services.map((service) => <details className="settings-service-card" key={service.id}><summary><span><strong>{service.name}</strong><small>{service.serviceDirectory} · {service.servicePort ? `Detected port ${service.servicePort}` : "Port detected at deployment"}</small></span><span>Edit</span></summary><div className="new-project-fields"><label className="field"><span>Name</span><input disabled={!project.canManage || busy} onChange={(event) => setServices((current) => current.map((item) => item.id === service.id ? { ...item, name: event.target.value } : item))} value={service.name} /></label><label className="field"><span>Directory</span><input disabled={!project.canManage || busy} onChange={(event) => setServices((current) => current.map((item) => item.id === service.id ? { ...item, serviceDirectory: event.target.value } : item))} value={service.serviceDirectory} /></label></div>{project.canManage ? <div className="quick-actions"><button className="button" disabled={busy} onClick={() => saveService(service)} type="button">Save service</button>{services.length > 1 ? <button className="danger-text-button" disabled={busy} onClick={() => removeService(service)} type="button">Remove</button> : null}</div> : null}</details>)}</div></section> : null}

    {activeSection === "variables" ? <section aria-labelledby="project-settings-tab-variables" className="panel-flat operational-surface settings-section-panel" id="project-settings-panel-variables" role="tabpanel"><div className="compact-section-heading"><div><p className="eyebrow">Variables</p><h2>Service environment</h2><p className="muted">Values are scoped to one service and remain masked after save.</p></div></div>{services.length > 1 ? <label className="field settings-service-selector"><span>Service</span><select onChange={(event) => setSelectedServiceId(event.target.value)} value={selectedService?.id || ""}>{services.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}</select></label> : null}{selectedService ? <EnvironmentVariablesPanel canManage={Boolean(project.canManage)} projectId={projectId} serviceId={selectedService.id} serviceName={selectedService.name} /> : <p className="muted">Add a service before configuring variables.</p>}</section> : null}

    {activeSection === "database" ? <form aria-labelledby="project-settings-tab-database" className="panel-flat operational-surface settings-simple-form settings-section-panel" id="project-settings-panel-database" onSubmit={saveDatabase} role="tabpanel"><div><p className="eyebrow">Database</p><h2>Managed database</h2><p className="muted">Configure one managed database and choose its attached service.</p></div><label className="field"><span>Database type</span><select disabled={!project.canManage || busy} onChange={(event) => setDatabase((current) => event.target.value === "none" ? { ...current, provider: "none" } : { ...current, provider: "managed", engine: event.target.value })} value={database.provider === "managed" ? database.engine : "none"}><option value="none">No managed database / use existing ENV</option><option value="postgres">PostgreSQL</option><option value="mysql">MySQL</option><option value="mongodb">MongoDB</option></select></label>{database.provider === "managed" ? <><label className="field"><span>Attached service</span><select disabled={!project.canManage || busy} onChange={(event) => setDatabase((current) => ({ ...current, attachedServiceId: event.target.value }))} value={database.attachedServiceId}>{services.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}</select></label><label className="checkbox-row"><input checked={database.persistenceEnabled} disabled={!project.canManage || busy} onChange={(event) => setDatabase((current) => ({ ...current, persistenceEnabled: event.target.checked }))} type="checkbox" />Persist database data</label></> : null}{project.canManage ? <button className="button" disabled={busy} type="submit">Save database</button> : null}</form> : null}

    {activeSection === "notifications" ? <section aria-labelledby="project-settings-tab-notifications" id="project-settings-panel-notifications" role="tabpanel"><NotificationSettingsPanel canManage={Boolean(project.canManage)} projectId={projectId} /></section> : null}

    {activeSection === "danger" ? <section aria-labelledby="project-settings-tab-danger" className="panel-flat operational-surface danger-zone settings-section-panel" id="project-settings-panel-danger" role="tabpanel"><div><p className="eyebrow">Danger zone</p><h2>Archive project</h2><p>Remove it from active workspace lists while retaining deployment history.</p></div>{project.canManage ? <button className="danger-text-button" disabled={busy} onClick={archive} type="button">Archive project</button> : null}</section> : null}
  </div>;
}
