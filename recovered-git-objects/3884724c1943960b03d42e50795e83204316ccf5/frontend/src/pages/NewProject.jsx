import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  createProject,
  generatePreflightReport,
  getGithubRepositories,
  getGithubConnectionStatus,
  inspectGithubRepository,
  runStackDetection,
} from "../api/projectApi.js";
import { getGithubAuthUrl } from "../api/authApi.js";
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
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("repositories");

  useEffect(() => {
    Promise.allSettled([getGithubConnectionStatus(), getGithubRepositories()]).then(([status, repositoryList]) => {
      if (status.status === "fulfilled") setGithubStatus(status.value);
      if (repositoryList.status === "fulfilled") setRepositories(repositoryList.value.repositories || []);
      else setRepositoryError(repositoryList.reason.message);
      setBusy("");
    });
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
      const activeProject = project || (await createProject({ repositoryFullName: fullName, targetBranch: branch, name: name.trim(), description: description.trim(), appDirectory: appDirectory.trim() || undefined })).project;
      setProject(activeProject);
      await runStackDetection(activeProject.id);
      await generatePreflightReport(activeProject.id);
      navigate(`/projects/${activeProject.id}/requirements`);
    } catch (caught) { setError(caught.message); } finally { setBusy(""); }
  }

  function reconnectGithub() {
    window.sessionStorage.setItem("deployguard_oauth_return_to", "/projects/new");
    window.location.assign(getGithubAuthUrl());
  }

  return <div className="workspace-page new-project-page">
    <header className="workspace-heading"><div><p className="eyebrow">New project</p><h1>Configure a repository</h1><p>Choose from GitHub or enter a public repository manually, then review the project before analysis.</p></div></header>
    {error ? <><ErrorState message={error} />{/active projects/i.test(error) ? <Link className="secondary-button" to="/projects">Open Projects to archive one</Link> : null}</> : null}
    {busy === "repositories" ? <LoadingState message="Loading your GitHub repositories…" /> : null}
    <section className="panel-flat repository-picker-card"><div className="deployment-step-number">1</div><div><h2>Repository and project</h2><p>Selecting a repository fills sensible defaults. Every project field remains editable.</p></div>
      {repositories.length ? <label className="field"><span>Your GitHub repositories</span><select disabled={Boolean(project)} onChange={(event) => chooseRepository(event.target.value)} value={selectedRepository?.fullName || ""}><option value="">Select a repository</option>{repositories.map((item) => <option key={item.id || item.fullName} value={item.fullName}>{item.fullName}{item.private ? " · Private" : ""}</option>)}</select></label> : null}
      {repositoryError ? <div className="state muted"><strong>GitHub repository list unavailable.</strong> {repositoryError} You can still enter a public repository below.{githubStatus?.oauthConfigured ? <button className="subtle-button" onClick={reconnectGithub} type="button">Reconnect GitHub</button> : <span> {githubStatus?.message}</span>}</div> : null}
      <label className="field"><span>Repository URL or owner/repository</span><input disabled={Boolean(project)} onChange={(event) => chooseRepository(event.target.value)} placeholder="https://github.com/owner/repository" value={repository} /></label>
      <button className="secondary-button" disabled={!repository || Boolean(project) || Boolean(busy)} onClick={loadBranches} type="button">{busy === "branches" ? "Loading branches…" : "Load branches"}</button>
      <div className="form-grid"><label className="field"><span>Project name</span><input disabled={Boolean(project)} onChange={(event) => setName(event.target.value)} placeholder="Loaded from repository metadata" value={name} /></label><label className="field"><span>Description</span><input disabled={Boolean(project)} onChange={(event) => setDescription(event.target.value)} placeholder="Loaded from repository metadata when available" value={description} /></label></div>
      <div className="form-grid"><label className="field"><span>Target branch</span>{branches.length ? <select disabled={Boolean(project)} onChange={(event) => setBranch(event.target.value)} value={branch}>{branches.map((item) => <option key={item} value={item}>{item}</option>)}</select> : <input disabled={Boolean(project)} onChange={(event) => setBranch(event.target.value)} placeholder="main" value={branch} />}</label><label className="field"><span>Application directory</span><input disabled={Boolean(project)} onChange={(event) => setAppDirectory(event.target.value)} placeholder="Automatic, or apps/api" value={appDirectory} /></label></div>
      <div className="state muted"><strong>Configuration comes after analysis.</strong> DeployGuard will create a form containing only the values this exact commit needs.</div>
      <div className="quick-actions"><Link className="secondary-button" to="/projects">Cancel</Link><button className="button" disabled={!repository || !branch || Boolean(busy)} onClick={analyze} type="button">{busy === "analysis" ? "Analyzing application…" : project ? "Retry analysis" : "Create and analyze"}</button></div>
    </section>
  </div>;
}

function normalizeFullName(value) {
  const normalized = String(value || "").trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
  return /^[^/\s]+\/[^/\s]+$/.test(normalized) ? normalized : "";
}
