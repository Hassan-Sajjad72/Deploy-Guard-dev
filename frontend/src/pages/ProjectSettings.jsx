import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  archiveProject,
  generatePreflightReport,
  getProject,
  getProjectBranches,
  runStackDetection,
  updateProject,
  updateProjectBranch,
  updateProjectRepository,
} from "../api/projectApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { PageHeader } from "../components/common/Premium.jsx";

const emptyOverrides = {
  installCommand: "", buildCommand: "", startCommand: "", outputDirectory: "",
  port: "", healthCheckPath: "", runtimeType: "", dockerfileMode: "",
};

export default function ProjectSettings() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [project, setProject] = useState(null);
  const [branches, setBranches] = useState([]);
  const [form, setForm] = useState({ name: "", description: "", visibility: "private", repositoryUrl: "", targetBranch: "main", appDirectory: "", deploymentOverrides: emptyOverrides });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const requirementsFocus = searchParams.get("focus");

  async function load() {
    setLoading(true); setError("");
    try {
      const { project: value } = await getProject(projectId);
      const overrides = value.deploymentOverrides || {};
      setProject(value);
      setForm({
        name: value.name || "", description: value.description || "", visibility: value.visibility || "private",
        repositoryUrl: value.repositoryUrl || "", targetBranch: value.targetBranch || "main", appDirectory: value.appDirectory || "",
        deploymentOverrides: { ...emptyOverrides, ...overrides },
      });
    } catch (caught) {
      setError(caught.status === 404 ? "Project not found." : caught.status === 403 ? "You do not have permission to view this project." : caught.message);
    } finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [projectId]);
  function change(event) { setForm((current) => ({ ...current, [event.target.name]: event.target.value })); }
  function changeOverride(event) { setForm((current) => ({ ...current, deploymentOverrides: { ...current.deploymentOverrides, [event.target.name]: event.target.value } })); }
  async function action(work, message) {
    setBusy(true); setError(""); setSuccess("");
    try { await work(); setSuccess(message); } catch (caught) { setError(caught.message); } finally { setBusy(false); }
  }
  async function saveDetails(event) {
    event.preventDefault();
    await action(async () => {
      const response = await updateProject(projectId, { name: form.name, description: form.description, visibility: form.visibility, appDirectory: form.appDirectory });
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
  async function saveOverrides(event) {
    event.preventDefault();
    await action(async () => {
      const source = form.deploymentOverrides;
      const deploymentOverrides = Object.fromEntries(Object.entries({ ...source, port: source.port ? Number(source.port) : undefined }).filter(([, value]) => value !== "" && value !== undefined));
      const response = await updateProject(projectId, { deploymentOverrides });
      setProject(response.project);
    }, "Deployment settings saved. Re-run analysis to apply them.");
  }
  async function rerunAnalysis() { await action(async () => { await runStackDetection(projectId); await generatePreflightReport(projectId); }, "Repository analysis completed."); }
  async function archive() { if (!window.confirm("Archive this project?")) return; await action(async () => { await archiveProject(projectId); navigate("/projects"); }, "Project archived."); }

  if (["database_setup", "missing_environment_variables"].includes(requirementsFocus)) return <Navigate replace to={`/projects/${projectId}/requirements?focus=${requirementsFocus === "database_setup" ? "database" : "secrets"}`} />;
  if (loading) return <div className="workspace-page"><LoadingState message="Loading project settings…" /></div>;
  if (!project) return <div className="workspace-page"><ErrorState message={error || "Project settings are unavailable."} onRetry={load} /><Link className="secondary-button" to="/projects">Back to Projects</Link></div>;

  return <div className="workspace-page">
    <PageHeader eyebrow="Application" title="Settings" description="Manage project identity, source, branch, application path, and deployment commands." context={`${project.repositoryFullName} · ${project.targetBranch}`} />
    {error ? <ErrorState message={error} /> : null}{success ? <div className="state success">{success}</div> : null}
    <div className="settings-restored-grid">
      <form className="panel-flat settings-simple-form" onSubmit={saveDetails}><div><p className="eyebrow">Project</p><h2>Project details</h2></div><label className="field"><span>Name</span><input disabled={!project.canManage || busy} name="name" onChange={change} required value={form.name} /></label><label className="field"><span>Description</span><input disabled={!project.canManage || busy} name="description" onChange={change} value={form.description} /></label><label className="field"><span>Application directory</span><input disabled={!project.canManage || busy} name="appDirectory" onChange={change} placeholder="Automatic, or apps/api" value={form.appDirectory} /></label><label className="field"><span>Visibility</span><select disabled={!project.canManage || busy} name="visibility" onChange={change} value={form.visibility}><option value="private">Private</option><option value="workspace">Workspace</option></select></label>{project.canManage ? <button className="button" disabled={busy} type="submit">Save project details</button> : null}</form>
      <form className="panel-flat settings-simple-form" onSubmit={saveRepository}><div><p className="eyebrow">Source</p><h2>Repository and branch</h2><p className="muted">Private repository access uses your encrypted credential.</p></div><label className="field"><span>Repository URL</span><input disabled={!project.canManage || busy} name="repositoryUrl" onChange={change} value={form.repositoryUrl} /></label>{project.canManage ? <button className="secondary-button" disabled={busy} type="submit">Update repository</button> : null}<label className="field"><span>Deployment branch</span>{branches.length ? <select disabled={!project.canManage || busy} name="targetBranch" onChange={change} value={form.targetBranch}>{branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}</select> : <input disabled={!project.canManage || busy} name="targetBranch" onChange={change} value={form.targetBranch} />}</label>{project.canManage ? <div className="quick-actions"><button className="subtle-button" disabled={busy} onClick={loadBranches} type="button">Load branches</button><button className="secondary-button" disabled={busy} onClick={saveBranch} type="button">Save branch</button></div> : null}</form>
    </div>
    <form className="panel-flat settings-simple-form" onSubmit={saveOverrides}><div><p className="eyebrow">Deployment</p><h2>Build and runtime settings</h2><p className="muted">Supported stacks use a DeployGuard-generated Dockerfile by default. Select repository-Dockerfile mode only for an explicit custom container build.</p></div><div className="form-grid">{[["installCommand", "Install command"], ["buildCommand", "Build command"], ["startCommand", "Start command"], ["outputDirectory", "Output directory"], ["port", "Port"], ["healthCheckPath", "Health check path"]].map(([name, label]) => <label className="field" key={name}><span>{label}</span><input disabled={!project.canManage || busy} name={name} onChange={changeOverride} placeholder="Automatic" type={name === "port" ? "number" : "text"} value={form.deploymentOverrides[name]} /></label>)}<label className="field"><span>Containerization</span><select disabled={!project.canManage || busy} name="dockerfileMode" onChange={changeOverride} value={form.deploymentOverrides.dockerfileMode}><option value="">DeployGuard-generated Dockerfile (default)</option><option value="custom">Use repository Dockerfile</option></select></label></div>{project.canManage ? <button className="button" disabled={busy} type="submit">Save deployment settings</button> : null}</form>
    <section className="panel-flat settings-link-card"><div><p className="eyebrow">Environment</p><h2>Requirements and variables</h2><p>Manage application-owned inputs, managed service bindings, and masked variables.</p></div><Link className="secondary-button" to={`/projects/${projectId}/requirements`}>Open Environment</Link></section>
    <section className="panel-flat settings-link-card"><div><p className="eyebrow">Repository analysis</p><h2>Refresh application detection</h2><p>Re-run analysis after changing the branch, source, or application directory.</p></div>{project.canManage ? <button className="button" disabled={busy} onClick={rerunAnalysis} type="button">Re-run analysis</button> : null}</section>
    {project.canManage ? <section className="panel-flat danger-zone"><div><h2>Archive project</h2><p>Remove it from active workspace lists while retaining history.</p></div><button className="danger-text-button" disabled={busy} onClick={archive} type="button">Archive project</button></section> : null}
  </div>;
}
