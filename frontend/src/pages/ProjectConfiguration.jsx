import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { createProjectService, deleteProjectService, getProject, getProjectBranches, getProjectDatabaseTier, updateProject, updateProjectBranch, updateProjectDatabaseTier, updateProjectRepository, updateProjectService } from "../api/projectApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { Button, Callout, Modal, PageHeader, Tabs } from "../components/common/DesignSystem.jsx";
import EnvironmentVariablesPanel from "../components/projects/EnvironmentVariablesPanel.jsx";
import { redirectDeletedProject } from "../utils/projectStateSync.js";

// What the next deployment builds and runs. Notifications and destructive actions stay in Settings.
const configurationSections = [
  { id: "services", label: "Services" },
  { id: "variables", label: "Variables" },
  { id: "database", label: "Database" },
  { id: "source", label: "Source" },
  { id: "general", label: "General" },
];

const DATABASE_OPTIONS = [
  ["none", "None — my app uses its own database"],
  ["postgres", "PostgreSQL (managed)"],
  ["mysql", "MySQL (managed)"],
  ["mongodb", "MongoDB (managed)"],
];
const UNCERTIFIED_ENGINES = { mysql: "MySQL", mongodb: "MongoDB" };
const databaseState = (database, services) => ({ provider: database?.provider || "none", engine: database?.engine || "postgres", persistenceEnabled: database?.persistenceEnabled !== false, attachedServiceId: database?.attachedServiceId || services[0]?.id || "" });

export default function ProjectConfiguration() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeSection = configurationSections.some((section) => section.id === searchParams.get("section")) ? searchParams.get("section") : "services";
  const [project, setProject] = useState(null);
  const [branches, setBranches] = useState([]);
  const [form, setForm] = useState({ name: "", description: "", visibility: "private", repositoryUrl: "", targetBranch: "main" });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [database, setDatabase] = useState(databaseState(null, []));
  const [services, setServices] = useState([]);
  const [applicationEntryPointServiceId, setApplicationEntryPointServiceId] = useState("");
  const [selectedServiceId, setSelectedServiceId] = useState("");
  const [confirm, setConfirm] = useState(null);
  const setActiveSection = (id) => { setError(""); setSuccess(""); setSearchParams(id === "services" ? {} : { section: id }, { replace: true }); };

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [{ project: value }, databaseResponse] = await Promise.all([getProject(projectId), getProjectDatabaseTier(projectId)]);
      const projectServices = value.services || [];
      setProject(value);
      setServices(projectServices);
      setSelectedServiceId((current) => current || projectServices[0]?.id || "");
      setApplicationEntryPointServiceId(value.applicationEntryPointServiceId || "");
      setForm({ name: value.name || "", description: value.description || "", visibility: value.visibility || "private", repositoryUrl: value.repositoryUrl || "", targetBranch: value.targetBranch || "main" });
      setDatabase(databaseState(databaseResponse.database, projectServices));
    } catch (caught) {
      if (!redirectDeletedProject(caught, navigate)) setError(caught.status === 403 ? "You do not have permission to view this project." : caught.message);
    } finally { setLoading(false); }
  }, [navigate, projectId]);

  useEffect(() => { void load(); }, [load]);
  function change(event) { setForm((current) => ({ ...current, [event.target.name]: event.target.value })); }
  async function action(work, message) {
    setBusy(true); setError(""); setSuccess("");
    try { await work(); setSuccess(message); } catch (caught) { setError(caught.message); } finally { setBusy(false); }
  }
  async function saveDetails(event) {
    event.preventDefault();
    await action(async () => { const response = await updateProject(projectId, { name: form.name, description: form.description, visibility: form.visibility }); setProject(response.project); }, "Project details saved.");
  }
  async function saveRepository(event) {
    event.preventDefault();
    await action(async () => { await updateProjectRepository(projectId, { repositoryUrl: form.repositoryUrl }); const response = await getProjectBranches(projectId); setBranches(response.branches || []); }, "Repository saved and branches loaded.");
  }
  async function loadBranches() { await action(async () => { const response = await getProjectBranches(projectId); setBranches(response.branches || []); }, "Branches loaded."); }
  async function saveBranch() { await action(async () => { await updateProjectBranch(projectId, form.targetBranch); setProject((current) => ({ ...current, targetBranch: form.targetBranch })); }, "Deployment branch saved. It is used from the next deployment."); }
  async function saveDatabase(event) {
    event.preventDefault();
    await action(async () => { const response = await updateProjectDatabaseTier(projectId, database); setDatabase(databaseState(response.database, services)); }, database.provider === "managed" ? "Managed database settings saved. They apply from the next approved deployment." : "Managed database turned off.");
  }
  async function addService() { await action(async () => { const response = await createProjectService(projectId, { name: `Service ${services.length + 1}`, serviceDirectory: "." }); setServices((current) => [...current, response.service]); setSelectedServiceId(response.service.id); }, "Service added. Set its name and directory below."); }
  async function saveService(service) { await action(async () => { const response = await updateProjectService(projectId, service.id, { name: service.name, serviceDirectory: service.serviceDirectory }); setServices((current) => current.map((item) => item.id === service.id ? response.service : item)); }, `${service.name} saved.`); }
  async function saveApplicationService(event) { event.preventDefault(); await action(async () => { const response = await updateProject(projectId, { applicationEntryPointServiceId }); setProject(response.project); setApplicationEntryPointServiceId(response.project.applicationEntryPointServiceId || ""); }, "Public service saved."); }
  async function removeService(service) { setConfirm(null); await action(async () => { await deleteProjectService(projectId, service.id); setServices((current) => { const next = current.filter((item) => item.id !== service.id); setSelectedServiceId((selected) => selected === service.id ? next[0]?.id || "" : selected); return next; }); }, `${service.name} removed.`); }

  if (loading) return <LoadingState message="Loading project configuration…" />;
  if (!project) return <div className="page"><ErrorState message={error || "Project configuration is unavailable."} onRetry={load} title="Configuration could not be loaded" /><div className="actions"><Link className="btn" to="/projects">Back to projects</Link></div></div>;

  const canManage = Boolean(project.canManage);
  const selectedService = services.find((service) => service.id === selectedServiceId) || services[0];
  const disabled = !canManage || busy;
  const panelProps = (id) => ({ "aria-labelledby": `project-configuration-tab-${id}`, id: `project-configuration-panel-${id}`, role: "tabpanel", tabIndex: 0, className: "settings-panel" });
  return <div className="page settings-page configuration-page">
    <PageHeader description={<>Builds <span className="mono">{project.repositoryFullName || project.repositoryUrl} · {project.targetBranch}</span>. Changes apply from the next deployment; the running release is untouched.</>} title="Configuration" />
    <div className="settings-layout">
      <nav className="settings-nav"><Tabs activeId={activeSection} idPrefix="project-configuration" items={configurationSections} label="Project configuration" onChange={setActiveSection} /></nav>
      <div className="settings-content">
        {!canManage ? <Callout title="Read-only access" tone="info"><p>You can view how this project is configured. Changing configuration is limited to developers.</p></Callout> : null}
        {error ? <ErrorState message={error} title="The change was not saved" /> : null}
        {success ? <Callout tone="success">{success}</Callout> : null}

        {activeSection === "services" ? <section {...panelProps("services")}>
          <div className="section-head"><div><h2>Services</h2><p>Each service is one runnable app from a directory in the repository. Its build and port are detected automatically.</p></div>{canManage ? <Button disabled={busy} icon="plus" onClick={addService}>Add service</Button> : null}</div>
          {services.length > 1 ? <form className="panel panel-pad settings-form" onSubmit={saveApplicationService}>
            <label className="field"><span>Public service</span><select disabled={disabled} name="applicationEntryPointServiceId" onChange={(event) => setApplicationEntryPointServiceId(event.target.value)} required value={applicationEntryPointServiceId}><option value="">Choose a service</option>{services.map((service) => <option key={service.id} value={service.id}>{service.name} — {service.serviceDirectory}</option>)}</select><small className="field-hint">The service your project URL and “Open app” lead to.</small></label>
            {canManage ? <div className="actions"><Button disabled={busy || !applicationEntryPointServiceId} type="submit">Save public service</Button></div> : null}
          </form> : null}
          <ul className="rows settings-services">{services.map((service) => <li key={service.id}><details className="settings-service">
            <summary><span><strong>{service.name}</strong><small className="mono">{service.serviceDirectory === "." ? "/ (repository root)" : service.serviceDirectory}</small></span><span className="muted">{service.servicePort ? <>Port <span className="mono">{service.servicePort}</span></> : "Port detected at deploy"}</span><span className="settings-service-edit">{canManage ? "Edit" : "View"}</span></summary>
            <div className="settings-service-body">
              <div className="field-row"><label className="field"><span>Name</span><input autoComplete="off" disabled={disabled} name="serviceName" onChange={(event) => setServices((current) => current.map((item) => item.id === service.id ? { ...item, name: event.target.value } : item))} value={service.name} /></label><label className="field"><span>Directory</span><input autoComplete="off" className="mono" disabled={disabled} name="serviceDirectory" onChange={(event) => setServices((current) => current.map((item) => item.id === service.id ? { ...item, serviceDirectory: event.target.value } : item))} spellCheck={false} value={service.serviceDirectory} /></label></div>
              {canManage ? <div className="actions"><Button disabled={busy} onClick={() => saveService(service)} tone="primary">Save service</Button>{services.length > 1 ? <Button disabled={busy} onClick={() => setConfirm({ service })} tone="ghost">Remove service</Button> : null}</div> : null}
            </div>
          </details></li>)}</ul>
        </section> : null}

        {activeSection === "variables" ? <section {...panelProps("variables")}>
          {services.length > 1 ? <label className="field settings-service-picker"><span>Service</span><select name="selectedServiceId" onChange={(event) => setSelectedServiceId(event.target.value)} value={selectedService?.id || ""}>{services.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}</select></label> : null}
          {selectedService ? <EnvironmentVariablesPanel canManage={canManage} key={selectedService.id} projectId={projectId} serviceId={selectedService.id} serviceName={selectedService.name} /> : <p className="muted">Add a service before configuring variables.</p>}
        </section> : null}

        {activeSection === "database" ? <form {...panelProps("database")} onSubmit={saveDatabase}>
          <div className="section-head"><div><h2>Database</h2><p>Attach one managed database that DeployGuard runs and connects for you, or keep using your own through variables. Provisioning requires an approved deployment plan.</p></div></div>
          <div className="panel panel-pad settings-form">
            <label className="field"><span>Database</span><select disabled={disabled} name="databaseEngine" onChange={(event) => setDatabase((current) => event.target.value === "none" ? { ...current, provider: "none" } : { ...current, provider: "managed", engine: event.target.value })} value={database.provider === "managed" ? database.engine : "none"}>{DATABASE_OPTIONS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
            {database.provider === "managed" && UNCERTIFIED_ENGINES[database.engine] ? <Callout tone="warning"><p>{UNCERTIFIED_ENGINES[database.engine]} has not yet completed live AWS certification. Database compatibility and customer AWS authority are checked during deployment planning.</p></Callout> : null}
            {database.provider === "managed" ? <>
              <label className="field"><span>Connected to</span><select disabled={disabled} name="attachedServiceId" onChange={(event) => setDatabase((current) => ({ ...current, attachedServiceId: event.target.value }))} value={database.attachedServiceId}>{services.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}</select><small className="field-hint">That service receives the connection variables automatically.</small></label>
              <label className="check"><input checked={database.persistenceEnabled} disabled={disabled} onChange={(event) => setDatabase((current) => ({ ...current, persistenceEnabled: event.target.checked }))} type="checkbox" /><span>Keep data between deployments<small>Stores data on encrypted, backed-up storage. Turn off only for throwaway data.</small></span></label>
            </> : <p className="field-hint">Set your own connection string (for example <span className="mono">DATABASE_URL</span>) under Variables.</p>}
          </div>
          {canManage ? <div className="actions actions-end"><Button aria-busy={busy || undefined} disabled={busy} tone="primary" type="submit">Save database</Button></div> : null}
        </form> : null}

        {activeSection === "source" ? <section {...panelProps("source")}>
          <div className="section-head"><div><h2>Source</h2><p>The repository and branch DeployGuard builds from. Private repositories use your encrypted GitHub access.</p></div></div>
          <form className="panel panel-pad settings-form" onSubmit={saveRepository}>
            <label className="field"><span>Repository URL</span><input disabled={disabled} name="repositoryUrl" onChange={change} spellCheck={false} value={form.repositoryUrl} /></label>
            {canManage ? <div className="actions"><Button disabled={busy} type="submit">Save repository</Button></div> : null}
          </form>
          <div className="panel panel-pad settings-form">
            <label className="field"><span>Deployment branch</span>{branches.length ? <select disabled={disabled} name="targetBranch" onChange={change} value={form.targetBranch}>{branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}</select> : <input disabled={disabled} name="targetBranch" onChange={change} spellCheck={false} value={form.targetBranch} />}<small className="field-hint">The next deployment builds the latest commit on this branch.</small></label>
            {canManage ? <div className="actions"><Button disabled={busy} onClick={saveBranch}>Save branch</Button>{!branches.length ? <Button disabled={busy} onClick={loadBranches} tone="ghost">Choose from GitHub</Button> : null}</div> : null}
          </div>
        </section> : null}

        {activeSection === "general" ? <form {...panelProps("general")} onSubmit={saveDetails}>
          <div className="section-head"><div><h2>General</h2><p>How this project appears in DeployGuard.</p></div></div>
          <div className="panel panel-pad settings-form">
            <label className="field"><span>Project name</span><input disabled={disabled} name="name" onChange={change} required value={form.name} /></label>
            <label className="field"><span>Description</span><input disabled={disabled} name="description" onChange={change} placeholder="Optional" value={form.description} /></label>
            <label className="field"><span>Visibility</span><select disabled={disabled} name="visibility" onChange={change} value={form.visibility}><option value="private">Private</option><option value="workspace">Workspace</option></select></label>
          </div>
          {canManage ? <div className="actions actions-end"><Button aria-busy={busy || undefined} disabled={busy} tone="primary" type="submit">Save changes</Button></div> : null}
        </form> : null}
      </div>
    </div>

    {confirm ? <Modal labelledBy="remove-service-title" onClose={() => setConfirm(null)}><h2 id="remove-service-title">Remove {confirm.service.name}?</h2><p>Its environment variables are removed too. The service stops on the next deployment.</p><div className="dialog-actions"><Button onClick={() => setConfirm(null)} tone="ghost">Cancel</Button><Button onClick={() => void removeService(confirm.service)} tone="danger-solid">Remove service</Button></div></Modal> : null}
  </div>;
}
