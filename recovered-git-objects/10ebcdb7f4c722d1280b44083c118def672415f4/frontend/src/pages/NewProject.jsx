import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  createProject,
  archiveProject,
  generatePreflightReport,
  getGithubRepositories,
  getGithubConnectionStatus,
  connectGithubAppInstallation,
  inspectGithubRepository,
  runStackDetection,
  getWorkspaceSummary,
} from "../api/projectApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";

export default function NewProject() {
  const navigate = useNavigate();
  const [repositories, setRepositories] = useState([]);
  const [repositoryError, setRepositoryError] = useState("");
  const [githubStatus, setGithubStatus] = useState(null);
  const [repository, setRepository] = useState("");
  const [branches, setBranches] = useState([]);
  const [branch, setBranch] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [appDirectory, setAppDirectory] = useState("");
  const [project, setProject] = useState(null);
  const [environmentName, setEnvironmentName] = useState("dev");
  const [existingProject, setExistingProject] = useState(null);
  const [creationWarnings, setCreationWarnings] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("repositories");

  useEffect(() => {
    const installationId = new URLSearchParams(window.location.search).get("installation_id");
    const connection = installationId ? connectGithubAppInstallation(installationId) : Promise.resolve();
    connection.then(() => Promise.allSettled([getGithubConnectionStatus(), getGithubRepositories(), getWorkspaceSummary()])).then(([status, repositoryList, workspace]) => {
      if (status.status === "fulfilled") setGithubStatus(status.value);
      if (repositoryList.status === "fulfilled") setRepositories(repositoryList.value.repositories || []);
      else setRepositoryError(repositoryList.reason.message);
      if (workspace.status === "fulfilled") setCreationWarnings(workspace.value.creationWarnings || []);
      setBusy("");
    }).catch((caught) => { setRepositoryError(caught.message); setBusy(""); });
  }, []);

  const selectedRepository = useMemo(() => repositories.find((item) => item.fullName === normalizeFullName(repository)), [repositories, repository]);

  function chooseRepository(value) {
    const selected = repositories.find((item) => item.fullName === value);
    setRepository(value);
    setBranches([]);
    setBranch(selected?.defaultBranch || "");
    setName(selected?.name || value.split("/").pop() || "");
    setDescription(selected?.description || "");
    setProject(null);
    setExistingProject(null);
  }

  async function loadBranches() {
    const fullName = normalizeFullName(repository);
    if (!fullName) { setError("Enter a GitHub repository as owner/repository or a full GitHub URL."); return; }
    setBusy("branches"); setError("");
    try {
      const response = await inspectGithubRepository(fullName);
      const details = response.repository;
      const available = details.branches || [];
      setBranches(available);
      const preferred = details.defaultBranch || selectedRepository?.defaultBranch;
      setBranch((current) => available.includes(current) ? current : available.includes(preferred) ? preferred : available[0] || "");
      setRepository(details.fullName);
      if (!name.trim()) setName(details.name);
      if (!description && details.description) setDescription(details.description);
    } catch (caught) { setError(caught.message); } finally { setBusy(""); }
  }

  async function analyze() {
    const fullName = normalizeFullName(repository);
    if (!fullName || !branch) { setError("Load a valid repository and select a branch first."); return; }
    setBusy("analysis"); setError("");
    try {
      const activeProject = project || (await createProject({ repositoryFullName: fullName, targetBranch: branch, environmentName, name: name.trim(), description: description.trim(), appDirectory: appDirectory.trim() || undefined })).project;
      setProject(activeProject);
      await runStackDetection(activeProject.id);
      await generatePreflightReport(activeProject.id);
      navigate(`/projects/${activeProject.id}/requirements`);
    } catch (caught) {
      const details = caught.payload?.existingProject ? caught.payload : caught.payload?.message;
      if (caught.code === "EXISTING_PROJECT" || details?.code === "EXISTING_PROJECT") {
        setExistingProject(details.existingProject);
        setError("");
      } else setError(caught.message);
    } finally { setBusy(""); }
  }

  async function archiveAndCreate() {
    if (!existingProject || !window.confirm(`Archive ${existingProject.name} and create a fresh project for ${repository} · ${branch} · ${environmentName}?`)) return;
    setBusy("archive"); setError("");
    try { await archiveProject(existingProject.id); setExistingProject(null); await analyze(); }
    catch (caught) { setError(caught.message); setBusy(""); }
  }

  function reconnectGithub() {
    if (githubStatus?.installUrl) window.location.assign(githubStatus.installUrl);
  }

  return <div className="workspace-page new-project-page">
    <header className="workspace-heading"><div><p className="eyebrow">New project</p><h1>Configure a repository</h1><p>Choose from GitHub or enter a public repository manually, then review the project before analysis.</p></div></header>
    {error ? <><ErrorState message={error} />{/active projects/i.test(error) ? <Link className="secondary-button" to="/projects">Open Projects to archive one</Link> : null}</> : null}
    {creationWarnings.length ? <section className="state warning"><div><strong>Another project still has active cloud resources.</strong><p>Continue if intended, but review resources that may incur AWS cost.</p>{creationWarnings.map((warning) => <div className="duplicate-project-summary" key={warning.projectId}><span><strong>{warning.projectName}</strong><small>{warning.deploymentStatus} · {warning.resourceStatus}</small></span><Link className="secondary-button compact-button" to={warning.reviewHref}>Review existing resources</Link></div>)}</div></section> : null}
    {existingProject ? <section className="panel duplicate-project-panel"><p className="eyebrow">Existing project</p><h2>This repository already has an existing project.</h2><dl className="metadata-list"><div><dt>Project</dt><dd>{existingProject.name}</dd></div><div><dt>Repository</dt><dd>{existingProject.repositoryFullName}</dd></div><div><dt>Branch</dt><dd>{existingProject.targetBranch}</dd></div><div><dt>Environment</dt><dd>{existingProject.environmentName || "dev"}</dd></div></dl><div className="quick-actions"><Link className="button" to={`/projects/${existingProject.id}`}>Open existing project</Link><button className="secondary-button" onClick={() => { setExistingProject(null); setEnvironmentName(environmentName === "dev" ? "testing-2" : `${environmentName}-2`); }} type="button">Create another environment</button><button className="danger-button" disabled={Boolean(busy)} onClick={archiveAndCreate} type="button">Archive existing and create fresh</button><button className="subtle-button" onClick={() => setExistingProject(null)} type="button">Cancel</button></div></section> : null}
    {busy === "repositories" ? <LoadingState message="Loading your GitHub repositories…" /> : null}
    <section className="panel-flat repository-picker-card"><div className="deployment-step-number">1</div><div><h2>Repository and project</h2><p>Selecting a repository fills sensible defaults. Every project field remains editable.</p></div>
      {repositories.length ? <label className="field"><span>Your GitHub repositories</span><select disabled={Boolean(project)} onChange={(event) => chooseRepository(event.target.value)} value={selectedRepository?.fullName || ""}><option value="">Select a repository</option>{repositories.map((item) => <option key={item.id || item.fullName} value={item.fullName}>{item.fullName}{item.private ? " · Private" : ""}</option>)}</select></label> : null}
      {!githubStatus?.connected ? <div className="state muted"><strong>GitHub App required.</strong> {githubStatus?.message}{githubStatus?.installUrl ? <button className="subtle-button" onClick={reconnectGithub} type="button">Install GitHub App</button> : null}</div> : null}
      {repositoryError ? <div className="state muted"><strong>GitHub repository list unavailable.</strong> {repositoryError}</div> : null}
      <label className="field"><span>Repository URL or owner/repository</span><input disabled={Boolean(project)} onChange={(event) => chooseRepository(event.target.value)} placeholder="https://github.com/owner/repository" value={repository} /></label>
      <button className="secondary-button" disabled={!repository || Boolean(project) || Boolean(busy)} onClick={loadBranches} type="button">{busy === "branches" ? "Loading branches…" : "Load branches"}</button>
      <div className="form-grid"><label className="field"><span>Project name</span><input disabled={Boolean(project)} onChange={(event) => setName(event.target.value)} placeholder="Loaded from repository metadata" value={name} /></label><label className="field"><span>Description</span><input disabled={Boolean(project)} onChange={(event) => setDescription(event.target.value)} placeholder="Loaded from repository metadata when available" value={description} /></label></div>
      <div className="form-grid"><label className="field"><span>Target branch</span>{branches.length ? <select disabled={Boolean(project)} onChange={(event) => { setBranch(event.target.value); setExistingProject(null); }} value={branch}>{branches.map((item) => <option key={item} value={item}>{item}</option>)}</select> : <input disabled={Boolean(project)} onChange={(event) => { setBranch(event.target.value); setExistingProject(null); }} placeholder="main" value={branch} />}</label><label className="field"><span>Environment</span><input disabled={Boolean(project)} pattern="[a-z0-9][a-z0-9-]{0,39}" onChange={(event) => { setEnvironmentName(event.target.value.toLowerCase()); setExistingProject(null); }} placeholder="dev, testing, staging, production" value={environmentName} /><small>A separate environment receives a distinct project ID, Terraform state key, AWS names, and deployment history.</small></label></div>
      <label className="field"><span>Application directory</span><input disabled={Boolean(project)} onChange={(event) => setAppDirectory(event.target.value)} placeholder="Automatic, or apps/api" value={appDirectory} /></label>
      <div className="state muted"><strong>Configuration comes after analysis.</strong> DeployGuard will create a form containing only the values this exact commit needs.</div>
      <div className="quick-actions"><Link className="secondary-button" to="/projects">Cancel</Link><button className="button" disabled={!repository || !branch || Boolean(busy)} onClick={analyze} type="button">{busy === "analysis" ? "Analyzing application…" : project ? "Retry analysis" : "Create and analyze"}</button></div>
    </section>
  </div>;
}

function normalizeFullName(value) {
  const normalized = String(value || "").trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
  return /^[^/\s]+\/[^/\s]+$/.test(normalized) ? normalized : "";
}
