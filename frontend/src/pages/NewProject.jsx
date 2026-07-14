import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  createProject,
  generatePreflightReport,
  getGithubRepositories,
  getGithubRepositoryBranches,
  runStackDetection,
  startProjectAutomation,
} from "../api/projectApi.js";
import AppIcon from "../components/common/AppIcon.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";

export default function NewProject() {
  const navigate = useNavigate();
  const [repositories, setRepositories] = useState([]);
  const [repository, setRepository] = useState("");
  const [branches, setBranches] = useState([]);
  const [branch, setBranch] = useState("");
  const [project, setProject] = useState(null);
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("repositories");

  useEffect(() => {
    getGithubRepositories()
      .then((response) => setRepositories(response.repositories || []))
      .catch((caught) => setError(caught.message))
      .finally(() => setBusy(""));
  }, []);

  const selectedRepository = useMemo(
    () => repositories.find((item) => item.fullName === repository),
    [repositories, repository]
  );

  async function selectRepository(value) {
    setRepository(value);
    setProject(null);
    setProfile(null);
    setError("");
    if (!value) { setBranches([]); setBranch(""); return; }
    const selected = repositories.find((item) => item.fullName === value);
    setBusy("branches");
    try {
      const response = await getGithubRepositoryBranches(value);
      const available = response.branches || [];
      setBranches(available);
      setBranch(available.includes(selected?.defaultBranch) ? selected.defaultBranch : available[0] || "");
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy("");
    }
  }

  async function analyze() {
    if (!repository || !branch) return;
    setBusy("analysis");
    setError("");
    try {
      const activeProject = project || (await createProject({ repositoryFullName: repository, targetBranch: branch })).project;
      setProject(activeProject);
      const detected = await runStackDetection(activeProject.id);
      await generatePreflightReport(activeProject.id);
      setProfile(detected.profile);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy("");
    }
  }

  async function deploy() {
    if (!project) return;
    setBusy("deploy");
    setError("");
    try {
      const response = await startProjectAutomation(project.id);
      if (response.automation?.status === "failed") throw new Error(response.automation.message || "Deployment could not start.");
      navigate(`/projects/${project.id}/pipeline`);
    } catch (caught) {
      setError(caught.message);
      setBusy("");
    }
  }

  return (
    <div className="workspace-page new-project-page">
      <header className="workspace-heading"><div><p className="eyebrow">New deployment</p><h1>Choose a repository</h1><p>DeployGuard uses your GitHub access to prepare the selected application.</p></div></header>
      {error ? <ErrorState message={error} /> : null}
      {busy === "repositories" ? <LoadingState message="Loading your GitHub repositories…" /> : null}
      {!busy && !repositories.length && !error ? <section className="workspace-empty-state"><AppIcon name="github" size={28} /><h2>No repositories available</h2><p>Confirm that this GitHub account can access a repository, then reconnect GitHub.</p></section> : null}
      {repositories.length ? <section className="panel-flat repository-picker-card">
        <div className="deployment-step-number">1</div>
        <div><h2>Repository</h2><p>Select a repository you own or collaborate on.</p></div>
        <label className="field"><span>GitHub repository</span><select disabled={Boolean(project)} onChange={(event) => selectRepository(event.target.value)} value={repository}><option value="">Select a repository</option>{repositories.map((item) => <option key={item.id || item.fullName} value={item.fullName}>{item.fullName}{item.private ? " · Private" : ""}</option>)}</select></label>
        {repository ? <label className="field"><span>Branch</span><select disabled={Boolean(project) || busy === "branches"} onChange={(event) => setBranch(event.target.value)} value={branch}>{branches.map((item) => <option key={item} value={item}>{item}</option>)}</select></label> : null}
        {selectedRepository?.description ? <p className="muted">{selectedRepository.description}</p> : null}
        {!profile ? <button className="button" disabled={!repository || !branch || Boolean(busy)} onClick={analyze} type="button">{busy === "analysis" ? "Analyzing application…" : project ? "Retry analysis" : "Analyze repository"}</button> : null}
      </section> : null}
      {project && profile ? <section className="panel-flat deployment-review-card">
        <div className="deployment-step-number">2</div>
        <div><p className="eyebrow">Ready to deploy</p><h2>{project.name}</h2><p>DeployGuard found a deployable application. Review the essentials, then start the deployment.</p></div>
        <dl className="developer-detail-grid"><div><dt>Framework</dt><dd>{profile.framework || profile.language || "Detected application"}</dd></div><div><dt>App directory</dt><dd>{profile.appDirectory || "Repository root"}</dd></div><div><dt>Build</dt><dd>{profile.buildCommand || "Automatic"}</dd></div><div><dt>Start</dt><dd>{profile.startCommand || "Automatic"}</dd></div><div><dt>Port</dt><dd>{profile.expectedPort || profile.port || "Automatic"}</dd></div><div><dt>Branch</dt><dd>{project.targetBranch}</dd></div></dl>
        <button className="button" disabled={Boolean(busy)} onClick={deploy} type="button">{busy === "deploy" ? "Starting deployment…" : "Deploy application"}</button>
      </section> : null}
    </div>
  );
}
