import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { bulkUpsertProjectEnvVars, connectGithubAppInstallation, createProject, deployGithubActionsDeployment, getGithubConnectionStatus, getGithubRepositories, inspectGithubRepository, updateProjectBranch } from "../api/projectApi.js";
import { ActionBar, Card, IssueCard, ReadinessSummary, StatusChip } from "../components/common/DesignSystem.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { parseEnvPaste } from "../utils/envPaste.js";
import { createDeploymentSelectionGate, deploymentSelectionKey } from "../utils/deploymentSelection.js";

function safeMessage(error) {
  const message = String(error?.message || "DeployGuard could not complete this step.");
  return /secret|token|password|authorization|cookie|private key/i.test(message)
    ? "DeployGuard could not complete this step safely. No application value was shown."
    : message;
}

function deploymentJourney(repository, branch, readiness, working, deployable) {
  const hasRepository = Boolean(repository);
  const hasBranch = Boolean(branch);
  const hasReadiness = Boolean(readiness);
  const readinessAttention = hasReadiness && !readiness.deployAllowed;
  return [
    { label: "Repository", detail: hasRepository ? repository : "Select source", state: hasRepository ? "complete" : "current" },
    { label: "Branch", detail: hasBranch ? branch : "Choose branch", state: hasBranch ? "complete" : hasRepository ? "current" : "waiting" },
    { label: "Environment", detail: working === "review" ? "Saving optional values" : hasReadiness ? "Ready" : "Optional", state: working === "review" ? "current" : hasReadiness ? "complete" : hasBranch ? "current" : "waiting" },
    { label: "Deploy", detail: working === "deploy" ? "Starting operation" : deployable ? "Ready to start" : "Not started", state: working === "deploy" ? "current" : deployable ? "ready" : "waiting" },
  ];
}

export default function NewProject() {
  const location = useLocation();
  const navigate = useNavigate();
  const deployInFlight = useRef(false);
  const selectionGate = useRef(createDeploymentSelectionGate());
  const [status, setStatus] = useState(null);
  const [repositories, setRepositories] = useState([]);
  const [repository, setRepository] = useState("");
  const [branch, setBranch] = useState("");
  const [branches, setBranches] = useState([]);
  const [envPaste, setEnvPaste] = useState("");
  const [readiness, setReadiness] = useState(null);
  const [savedEnvironmentCount, setSavedEnvironmentCount] = useState(0);
  const [ignoredEnvironmentNames, setIgnoredEnvironmentNames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState("");
  const parsed = useMemo(() => parseEnvPaste(envPaste), [envPaste]);
  const currentSelection = deploymentSelectionKey(repository, branch);
  const deployable = Boolean(readiness?.project?.id && readiness.selection === currentSelection && readiness.deployAllowed === true && ["ready", "warning"].includes(readiness.level));
  const journey = deploymentJourney(repository, branch, readiness, working, deployable);

  async function refresh() {
    const [connection, list] = await Promise.all([getGithubConnectionStatus(), getGithubRepositories()]);
    setStatus(connection);
    setRepositories(list.repositories || []);
  }

  useEffect(() => {
    let active = true;
    const installationId = new URLSearchParams(location.search).get("installation_id");
    (async () => {
      try {
        if (installationId) await connectGithubAppInstallation(installationId);
        await refresh();
      } catch (caught) {
        if (active) setReadiness({ level: "blocked", message: safeMessage(caught) });
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [location.search]);

  async function chooseRepository(value) {
    const inspectionTicket = selectionGate.current.begin(value, "");
    setWorking((current) => current === "review" ? "" : current);
    const item = repositories.find((entry) => entry.fullName === value);
    setRepository(value);
    setBranch("");
    setBranches([]);
    setReadiness(null);
    setSavedEnvironmentCount(0);
    setIgnoredEnvironmentNames([]);
    if (!value) return;
    try {
      const details = (await inspectGithubRepository(value)).repository;
      if (!selectionGate.current.isCurrent(inspectionTicket)) return;
      const availableBranches = Array.from(new Set([details.defaultBranch || item?.defaultBranch, ...(details.branches || [])].filter(Boolean)));
      setBranches(availableBranches);
      const nextBranch = details.defaultBranch || availableBranches[0] || "";
      selectionGate.current.select(value, nextBranch);
      setBranch(nextBranch);
    } catch (caught) {
      if (!selectionGate.current.isCurrent(inspectionTicket)) return;
      setReadiness({ level: "blocked", message: safeMessage(caught) });
    }
  }

  function changeBranch(value) {
    selectionGate.current.select(repository, value);
    setWorking((current) => current === "review" ? "" : current);
    setBranch(value);
    setReadiness(null);
    setSavedEnvironmentCount(0);
    setIgnoredEnvironmentNames([]);
  }

  function changeEnvironment(value) {
    setEnvPaste(value);
    if (readiness) setReadiness(null);
  }

  async function reviewReadiness() {
    if (!repository || !branch || parsed.errors.length) return;
    const requestedRepository = repository;
    const requestedBranch = branch;
    const ticket = selectionGate.current.begin(requestedRepository, requestedBranch);
    const isCurrent = () => selectionGate.current.isCurrent(ticket);
    setWorking("review");
    setReadiness(null);
    try {
      let project;
      try {
        project = (await createProject({ repositoryFullName: requestedRepository, targetBranch: requestedBranch, name: requestedRepository.split("/").pop() })).project;
      } catch (caught) {
        if (caught.code === "EXISTING_PROJECT" || caught.payload?.code === "EXISTING_PROJECT") project = caught.payload.existingProject;
        else throw caught;
      }
      if (!isCurrent()) return;
      if (String(project.repositoryFullName || "").toLowerCase() !== requestedRepository.toLowerCase()) {
        throw new Error("The existing project belongs to a different repository. Review readiness again.");
      }
      if (project.targetBranch !== requestedBranch) {
        project = (await updateProjectBranch(project.id, requestedBranch)).project;
      }
      if (!isCurrent()) return;
      if (parsed.entries.length) {
        const saved = await bulkUpsertProjectEnvVars(project.id, parsed.entries.map(({ key, value, isSecret }) => ({ key, value, isSecret, scope: "runtime" })));
        if (!isCurrent()) return;
        setSavedEnvironmentCount(saved.variables?.length || 0);
        setIgnoredEnvironmentNames([...new Set([...(parsed.ignoredVariableNames || []), ...(saved.ignoredVariableNames || [])])].sort());
        setEnvPaste("");
      } else {
        setIgnoredEnvironmentNames(parsed.ignoredVariableNames || []);
      }
      setReadiness({ level: "ready", deployAllowed: true, requiredInputs: [], message: "Repository, branch, and optional environment are ready for deployment.", project, selection: ticket.selection });
    } catch (caught) {
      if (isCurrent()) setReadiness({ level: "blocked", message: safeMessage(caught), selection: ticket.selection });
    } finally {
      if (isCurrent()) setWorking("");
    }
  }

  async function deploy() {
    if (deployInFlight.current || !deployable) return;
    deployInFlight.current = true;
    setWorking("deploy");
    try {
      await deployGithubActionsDeployment(readiness.project.id);
      navigate(`/projects/${readiness.project.id}`);
    } catch (caught) {
      setReadiness((current) => current ? { ...current, level: "blocked", message: safeMessage(caught) } : { level: "blocked", message: safeMessage(caught) });
    } finally {
      deployInFlight.current = false;
      setWorking("");
    }
  }

  if (loading) return <LoadingState message="Checking GitHub App access…" />;

  return <div className="workspace-page new-project-page">
    <header className="workspace-heading"><div><p className="eyebrow">Deploy</p><h1>Deploy a GitHub repository</h1><p>Choose an authorized repository and branch, optionally paste environment values, then deploy.</p></div></header>
    {!status?.connected ? <Card className="new-project-connection" tone="warning"><StatusChip status="blocked">Blocked</StatusChip><h2>Connect GitHub App</h2><p>{status?.message || "GitHub App access is required before a repository can be selected."}</p><div className="quick-actions">{status?.availableInstallations?.map((item) => <button className="button" key={item.installationId} onClick={() => void connectGithubAppInstallation(item.installationId).then(refresh).catch((caught) => setReadiness({ level: "blocked", message: safeMessage(caught) }))} type="button">Connect {item.accountLogin}</button>)}{status?.installUrl ? <a className="secondary-button" href={status.installUrl}>Install GitHub App</a> : null}</div></Card> : <Card className="new-project-form">
      <div className="new-project-form-heading"><p className="eyebrow">New deployment</p><h2>Repository, branch, and environment</h2><p>Application values are optional. DeployGuard manages runtime PORT and HOST.</p></div>
      <ol aria-label="Deployment readiness journey" className="deployment-journey">{journey.map((step) => <li className={`is-${step.state}`} key={step.label}><span aria-hidden="true" className="deployment-journey-marker" /><div><strong>{step.label}</strong><small>{step.detail}</small></div></li>)}</ol>
      <div className="new-project-fields"><label className="field"><span>Authorized repository</span><select disabled={working === "deploy"} onChange={(event) => void chooseRepository(event.target.value)} value={repository}><option value="">Select a repository</option>{repositories.map((item) => <option key={item.id || item.fullName} value={item.fullName}>{item.fullName}</option>)}</select></label><label className="field"><span>Branch</span><select disabled={!repository || working === "deploy"} onChange={(event) => changeBranch(event.target.value)} value={branch}><option value="">Select a branch</option>{branches.map((item) => <option key={item} value={item}>{item}</option>)}</select></label></div>
      <label className="field"><span>Optional application .env</span><textarea disabled={Boolean(working)} onChange={(event) => changeEnvironment(event.target.value)} placeholder={"# Optional\nAPI_URL=https://example.test"} rows="7" value={envPaste} /><small>Values are encrypted for the project and are never shown again after they are saved.</small></label>
      {parsed.errors.map((message) => <IssueCard key={message} severity="danger" title="Invalid environment input"><p>{message}</p></IssueCard>)}
      {parsed.warnings?.map((message) => <IssueCard key={message} severity="warning" title="Input ignored"><p>{message}</p></IssueCard>)}
      {ignoredEnvironmentNames.map((key) => <IssueCard key={key} severity="warning" title="Platform-managed value"><p>{key} is managed by DeployGuard and was ignored.</p></IssueCard>)}
      {savedEnvironmentCount ? <IssueCard severity="success" title="Application configuration saved"><p>{savedEnvironmentCount} value{savedEnvironmentCount === 1 ? " was" : "s were"} accepted; values are not displayed.</p></IssueCard> : null}
      {readiness ? <ReadinessSummary level={readiness.level} message={readiness.message} requiredInputs={readiness.requiredInputs}>
        <small>No source inspection or framework selection occurs before deployment.</small>
      </ReadinessSummary> : null}
      <ActionBar className="new-project-actions" label="Deployment actions"><button className="secondary-button" disabled={Boolean(working) || !repository || !branch || parsed.errors.length} onClick={() => void reviewReadiness()} type="button">{working === "review" ? "Saving…" : "Continue"}</button><button className="button" disabled={Boolean(working) || !deployable} onClick={() => void deploy()} type="button">{working === "deploy" ? "Starting deployment…" : "Deploy"}</button></ActionBar>
    </Card>}
  </div>;
}
