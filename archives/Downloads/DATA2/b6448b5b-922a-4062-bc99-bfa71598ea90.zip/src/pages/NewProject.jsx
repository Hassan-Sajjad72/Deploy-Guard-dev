import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { bulkUpsertProjectEnvVars, connectGithubAppInstallation, createProject, deployGithubActionsDeployment, generatePreflightReport, getGithubConnectionStatus, getGithubRepositories, inspectGithubRepository, runStackDetection, updateProjectBranch } from "../api/projectApi.js";
import { Card, StatusChip } from "../components/common/DesignSystem.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { parseEnvPaste } from "../utils/envPaste.js";
import { createDeploymentSelectionGate, deploymentSelectionKey } from "../utils/deploymentSelection.js";

function safeMessage(error) {
  const message = String(error?.message || "DeployGuard could not complete this step.");
  return /secret|token|password|authorization|cookie|private key/i.test(message)
    ? "DeployGuard could not complete this step safely. No application value was shown."
    : message;
}

function readinessFrom(profile, report) {
  const detectionErrors = Array.isArray(profile?.errors) ? profile.errors : [];
  if (profile?.detectionStatus !== "success") {
    return { level: "blocked", message: detectionErrors[0] || "DeployGuard could not verify a supported application stack for this branch." };
  }
  const errors = Array.isArray(report?.errors) ? report.errors : [];
  if (["failed", "manual_dockerfile_required"].includes(report?.validationStatus)) {
    return { level: "blocked", message: errors[0] || "This repository needs a deployment configuration correction before it can deploy." };
  }
  const warnings = Array.isArray(report?.warnings) ? report.warnings : [];
  if (report?.validationStatus === "passed_with_warnings" || warnings.length) {
    return { level: "warning", message: warnings[0] || "Deployment readiness has a non-blocking warning." };
  }
  return { level: "ready", message: "This repository and branch passed DeployGuard’s deployment readiness checks." };
}

function databaseLabel(engine) {
  return engine === "mysql" ? "MySQL" : engine === "mongodb" ? "MongoDB" : "PostgreSQL";
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
  const deployable = Boolean(readiness?.project?.id && readiness.selection === currentSelection && ["ready", "warning"].includes(readiness.level));

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
      const { profile } = await runStackDetection(project.id);
      if (!isCurrent()) return;
      if (String(profile.repositoryFullName || "").toLowerCase() !== requestedRepository.toLowerCase() || profile.targetBranch !== requestedBranch) {
        throw new Error("Repository analysis returned evidence for a stale repository selection. Review readiness again.");
      }
      if (parsed.entries.length) {
        const saved = await bulkUpsertProjectEnvVars(project.id, parsed.entries.map(({ key, value, isSecret }) => ({ key, value, isSecret, scope: "runtime" })));
        if (!isCurrent()) return;
        setSavedEnvironmentCount(saved.variables?.length || 0);
        setIgnoredEnvironmentNames([...new Set([...(parsed.ignoredVariableNames || []), ...(saved.ignoredVariableNames || [])])].sort());
        setEnvPaste("");
      } else {
        setIgnoredEnvironmentNames(parsed.ignoredVariableNames || []);
      }
      const { report } = await generatePreflightReport(project.id);
      if (!isCurrent()) return;
      const reportProject = report?.report?.project;
      if (String(reportProject?.repositoryFullName || "").toLowerCase() !== requestedRepository.toLowerCase() || reportProject?.targetBranch !== requestedBranch || reportProject?.commitSha !== profile.commitSha) {
        throw new Error("Readiness returned a stale repository contract. Review readiness again.");
      }
      setReadiness({ ...readinessFrom(profile, report), project, profile, report, selection: ticket.selection });
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
    <header className="workspace-heading"><div><p className="eyebrow">Deploy</p><h1>Deploy a GitHub repository</h1><p>Choose an authorized repository and branch. Readiness is checked on this page before one Deploy action starts GitHub Actions.</p></div></header>
    {!status?.connected ? <Card className="new-project-connection" tone="warning"><StatusChip status="blocked">Blocked</StatusChip><h2>Connect GitHub App</h2><p>{status?.message || "GitHub App access is required before a repository can be selected."}</p><div className="quick-actions">{status?.availableInstallations?.map((item) => <button className="button" key={item.installationId} onClick={() => void connectGithubAppInstallation(item.installationId).then(refresh).catch((caught) => setReadiness({ level: "blocked", message: safeMessage(caught) }))} type="button">Connect {item.accountLogin}</button>)}{status?.installUrl ? <a className="secondary-button" href={status.installUrl}>Install GitHub App</a> : null}</div></Card> : <Card className="new-project-form">
      <div className="new-project-form-heading"><p className="eyebrow">New deployment</p><h2>Repository and readiness</h2><p>Only application-owned configuration belongs in the optional paste area. Platform and repository-owned values remain automatic.</p></div>
      <div className="new-project-fields"><label className="field"><span>Authorized repository</span><select disabled={working === "deploy"} onChange={(event) => void chooseRepository(event.target.value)} value={repository}><option value="">Select a repository</option>{repositories.map((item) => <option key={item.id || item.fullName} value={item.fullName}>{item.fullName}</option>)}</select></label><label className="field"><span>Branch</span><select disabled={!repository || working === "deploy"} onChange={(event) => changeBranch(event.target.value)} value={branch}><option value="">Select a branch</option>{branches.map((item) => <option key={item} value={item}>{item}</option>)}</select></label></div>
      <label className="field"><span>Optional application .env</span><textarea disabled={Boolean(working)} onChange={(event) => changeEnvironment(event.target.value)} placeholder={"# Optional\nAPI_URL=https://example.test"} rows="7" value={envPaste} /><small>Values are encrypted for the project and are never shown again after they are saved.</small></label>
      {parsed.errors.map((message) => <section className="state error" key={message}><StatusChip status="blocked">Blocked</StatusChip><p>{message}</p></section>)}
      {parsed.warnings?.map((message) => <section className="state warning" key={message}><StatusChip status="warning">Ignored</StatusChip><p>{message}</p></section>)}
      {ignoredEnvironmentNames.map((key) => <section className="state warning" key={key}><StatusChip status="warning">Ignored</StatusChip><p>{key} is managed by DeployGuard and was ignored.</p></section>)}
      {savedEnvironmentCount ? <section className="state success"><StatusChip status="ready">Ready</StatusChip><p>Application configuration was saved. {savedEnvironmentCount} value{savedEnvironmentCount === 1 ? " was" : "s were"} accepted; values are not displayed.</p></section> : null}
      {readiness ? <section className={`deployment-readiness deployment-readiness-${readiness.level}`} aria-live="polite"><div><p className="eyebrow">Deployment readiness</p><StatusChip status={readiness.level}>{readiness.level[0].toUpperCase() + readiness.level.slice(1)}</StatusChip><p>{readiness.message}</p>{readiness.profile ? <dl className="details-list"><div><dt>Detector</dt><dd>{readiness.profile.detectorId || "—"}</dd></div><div><dt>Mode</dt><dd>{readiness.profile.frameworkVariant || "—"}</dd></div><div><dt>Build</dt><dd>{readiness.profile.buildCommand || "—"}</dd></div><div><dt>Output</dt><dd>{readiness.profile.outputDirectory || "—"}</dd></div><div><dt>Branch</dt><dd>{readiness.profile.targetBranch || "—"}</dd></div><div><dt>Commit</dt><dd><code>{readiness.profile.commitSha || "—"}</code></dd></div></dl> : null}{(readiness.profile?.requiresDatabase || readiness.report?.report?.deploymentProfile?.requiresDatabase) ? <section className="state success"><StatusChip status="ready">Managed {databaseLabel(readiness.profile?.databaseType || readiness.report?.report?.deploymentProfile?.databaseType)}</StatusChip><p>DeployGuard will provision the project-scoped database service, EFS persistence, private networking, secrets, and service discovery automatically. Database values are injected at deployment and never need to be entered here.</p></section> : null}<small>Repository analysis and pre-flight stay on this page. No deployment has started.</small></div></section> : null}
      <div className="new-project-actions"><button className="secondary-button" disabled={Boolean(working) || !repository || !branch || parsed.errors.length} onClick={() => void reviewReadiness()} type="button">{working === "review" ? "Reviewing readiness…" : "Review readiness"}</button><button className="button" disabled={Boolean(working) || !deployable} onClick={() => void deploy()} type="button">{working === "deploy" ? "Starting deployment…" : "Deploy"}</button></div>
    </Card>}
  </div>;
}
