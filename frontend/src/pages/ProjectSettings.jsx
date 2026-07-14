import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { archiveProject, getProject, getProjectBranches, updateProject, updateProjectBranch } from "../api/projectApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { PageHeader } from "../components/common/Premium.jsx";

export default function ProjectSettings() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState(null);
  const [branch, setBranch] = useState("");
  const [appDirectory, setAppDirectory] = useState("");
  const [branches, setBranches] = useState([]);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { getProject(projectId).then(({ project: value }) => { setProject(value); setBranch(value.targetBranch || "main"); setAppDirectory(value.appDirectory || ""); return getProjectBranches(projectId); }).then((response) => setBranches(response.branches || [])).catch((caught) => setError(caught.message)); }, [projectId]);
  async function save(event) { event.preventDefault(); setBusy(true); setError(""); try { if (branch !== project.targetBranch) await updateProjectBranch(projectId, branch); await updateProject(projectId, { appDirectory }); setProject((value) => ({ ...value, targetBranch: branch, appDirectory })); setSuccess("Settings saved."); } catch (caught) { setError(caught.message); } finally { setBusy(false); } }
  async function archive() { if (!window.confirm("Archive this project?")) return; setBusy(true); try { await archiveProject(projectId); navigate("/projects"); } catch (caught) { setError(caught.message); setBusy(false); } }
  if (!project) return error ? <ErrorState message={error} /> : <LoadingState message="Loading settings…" />;
  return <div className="workspace-page"><PageHeader eyebrow="Project" title="Settings" description="Change the deployment branch, application directory, or runtime environment." context={`${project.repositoryFullName} · ${project.targetBranch}`} />{error ? <ErrorState message={error} /> : null}{success ? <div className="state success">{success}</div> : null}<form className="panel-flat settings-simple-form" onSubmit={save}><div><p className="eyebrow">Source</p><h2>{project.name}</h2><p className="muted">{project.repositoryFullName}</p></div><label className="field"><span>Deployment branch</span><select disabled={!project.canManage || busy} onChange={(event) => setBranch(event.target.value)} value={branch}>{branches.map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label className="field"><span>Application directory</span><input disabled={!project.canManage || busy} onChange={(event) => setAppDirectory(event.target.value)} placeholder="Repository root" value={appDirectory} /><small>Leave empty unless the application is in a subdirectory.</small></label>{project.canManage ? <button className="button" disabled={busy} type="submit">Save settings</button> : null}</form><section className="panel-flat settings-link-card"><div><p className="eyebrow">Runtime</p><h2>Environment variables</h2><p>Manage application configuration. Secret values remain masked.</p></div><Link className="secondary-button" to={`/projects/${projectId}/env`}>Manage variables</Link></section>{project.canManage ? <section className="panel-flat danger-zone"><div><h2>Archive project</h2><p>Remove this project from the active workspace without deleting its audit history.</p></div><button className="danger-text-button" disabled={busy} onClick={archive} type="button">Archive project</button></section> : null}</div>;
}
