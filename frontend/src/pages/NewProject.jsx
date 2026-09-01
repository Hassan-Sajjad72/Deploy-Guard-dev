import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { bulkUpsertProjectServiceEnvVars, connectGithubAppInstallation, createProject, deployGithubActionsDeployment, getGithubConnectionStatus, getGithubRepositories, getGithubRepositoryDirectories, inspectGithubRepository, updateProject, updateProjectBranch, updateProjectDatabaseTier } from "../api/projectApi.js";
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

function compareDirectoryPresentation(left, right) {
  if (left === ".") return right === "." ? 0 : -1;
  if (right === ".") return 1;
  const depthDifference = left.split("/").length - right.split("/").length;
  if (depthDifference) return depthDifference;
  const leftFolded = left.toLocaleLowerCase();
  const rightFolded = right.toLocaleLowerCase();
  if (leftFolded < rightFolded) return -1;
  if (leftFolded > rightFolded) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

const MANAGED_DATABASE_ALIASES = {
  postgres: ["DB_HOST", "DATABASE_HOST", "POSTGRES_HOST", "PGHOST", "DB_PORT", "DATABASE_PORT", "POSTGRES_PORT", "PGPORT", "DB_USER", "DATABASE_USER", "POSTGRES_USER", "PGUSER", "DB_PASSWORD", "DATABASE_PASSWORD", "POSTGRES_PASSWORD", "PGPASSWORD", "DB_NAME", "DATABASE_NAME", "POSTGRES_DB", "PGDATABASE", "DATABASE_URL", "POSTGRES_URL", "POSTGRESQL_URL"],
  mysql: ["DB_HOST", "DATABASE_HOST", "MYSQL_HOST", "DB_PORT", "DATABASE_PORT", "MYSQL_PORT", "DB_USER", "DATABASE_USER", "MYSQL_USER", "DB_PASSWORD", "DATABASE_PASSWORD", "MYSQL_PASSWORD", "DB_NAME", "DATABASE_NAME", "MYSQL_DATABASE", "DATABASE_URL", "MYSQL_URL"],
  mongodb: ["DB_HOST", "DATABASE_HOST", "MONGO_HOST", "MONGODB_HOST", "DB_PORT", "DATABASE_PORT", "MONGO_PORT", "MONGODB_PORT", "DB_USER", "DATABASE_USER", "MONGO_USER", "MONGODB_USER", "DB_PASSWORD", "DATABASE_PASSWORD", "MONGO_PASSWORD", "MONGODB_PASSWORD", "DB_NAME", "DATABASE_NAME", "MONGO_DB", "MONGODB_DATABASE", "DATABASE_URL", "MONGO_URI", "MONGO_URL", "MONGODB_URI"],
};

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
  const [services, setServices] = useState([{ key: crypto.randomUUID(), name: "Web", serviceDirectory: "", servicePort: "8080", envPaste: "" }]);
  const [applicationEntryPointServiceId, setApplicationEntryPointServiceId] = useState("");
  const [directories, setDirectories] = useState(["."]);
  const [database, setDatabase] = useState({ provider: "none", engine: "postgres", attachedServiceKey: "" });
  const [readiness, setReadiness] = useState(null);
  const [savedEnvironmentCount, setSavedEnvironmentCount] = useState(0);
  const [ignoredEnvironmentNames, setIgnoredEnvironmentNames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState("");
  const parsedServices = useMemo(() => services.map((service) => ({ service, parsed: parseEnvPaste(service.envPaste) })), [services]);
  const rankedDirectories = useMemo(() => [...directories].sort(compareDirectoryPresentation), [directories]);
  const attachedDatabaseServiceKey = database.attachedServiceKey || services[0]?.key;
  const managedDatabaseConflicts = database.provider === "managed"
    ? (parsedServices.find(({ service }) => service.key === attachedDatabaseServiceKey)?.parsed.entries || []).filter(({ key }) => MANAGED_DATABASE_ALIASES[database.engine]?.includes(key)).map(({ key }) => key)
    : [];
  const hasServiceErrors = parsedServices.some(({ parsed }) => parsed.errors.length) || services.some((service) => !service.name.trim() || !service.serviceDirectory.trim() || !/^\d+$/.test(service.servicePort) || Number(service.servicePort) < 1 || Number(service.servicePort) > 65535) || new Set(services.map((service) => service.name.trim().toLowerCase())).size !== services.length || (services.length > 1 && !services.some((service) => service.key === applicationEntryPointServiceId)) || managedDatabaseConflicts.length > 0;
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
    let directoryTicket = inspectionTicket;
    setWorking((current) => current === "review" ? "" : current);
    const item = repositories.find((entry) => entry.fullName === value);
    setRepository(value);
    setBranch("");
    setBranches([]);
    setDirectories(["."]);
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
      directoryTicket = selectionGate.current.begin(value, nextBranch);
      setBranch(nextBranch);
      if (nextBranch) {
        const response = await getGithubRepositoryDirectories(value, nextBranch);
        if (!selectionGate.current.isCurrent(directoryTicket)) return;
        setDirectories(response.directories || ["."]);
      }
    } catch (caught) {
      if (!selectionGate.current.isCurrent(directoryTicket)) return;
      setReadiness({ level: "blocked", message: safeMessage(caught) });
    }
  }

  async function changeBranch(value) {
    const directoryTicket = selectionGate.current.begin(repository, value);
    setWorking((current) => current === "review" ? "" : current);
    setBranch(value);
    setReadiness(null);
    setSavedEnvironmentCount(0);
    setIgnoredEnvironmentNames([]);
    setDirectories(["."]);
    if (repository && value) {
      try {
        const response = await getGithubRepositoryDirectories(repository, value);
        if (!selectionGate.current.isCurrent(directoryTicket)) return;
        setDirectories(response.directories || ["."]);
      } catch (caught) {
        if (selectionGate.current.isCurrent(directoryTicket)) setReadiness({ level: "blocked", message: safeMessage(caught) });
      }
    }
  }

  function changeService(key, field, value) {
    setServices((current) => current.map((service) => service.key === key ? { ...service, [field]: value } : service));
    if (readiness) setReadiness(null);
  }

  function addService() {
    setServices((current) => [...current, { key: crypto.randomUUID(), name: `Service ${current.length + 1}`, serviceDirectory: "", servicePort: "8080", envPaste: "" }]);
    if (readiness) setReadiness(null);
  }

  function removeService(key) {
    const remaining = services.filter((service) => service.key !== key);
    setServices(remaining);
    if (remaining.length === 1 || applicationEntryPointServiceId === key) setApplicationEntryPointServiceId("");
    if (readiness) setReadiness(null);
  }

  function changeApplicationService(serviceId) {
    setApplicationEntryPointServiceId(serviceId);
    if (readiness) setReadiness(null);
  }

  async function reviewReadiness() {
    if (!repository || !branch || hasServiceErrors) return;
    const requestedRepository = repository;
    const requestedBranch = branch;
    const ticket = selectionGate.current.begin(requestedRepository, requestedBranch);
    const isCurrent = () => selectionGate.current.isCurrent(ticket);
    setWorking("review");
    setReadiness(null);
    try {
      let project; let existingProject = false;
      try {
        project = (await createProject({ repositoryFullName: requestedRepository, targetBranch: requestedBranch, name: requestedRepository.split("/").pop(), applicationEntryPointServiceId: services.length === 1 ? services[0].key : applicationEntryPointServiceId, services: services.map(({ key, name, serviceDirectory, servicePort }) => ({ id: key, name, serviceDirectory, servicePort: Number(servicePort) })) })).project;
      } catch (caught) {
        if (caught.code === "EXISTING_PROJECT" || caught.payload?.code === "EXISTING_PROJECT") { project = caught.payload.existingProject; existingProject = true; }
        else throw caught;
      }
      if (!isCurrent()) return;
      if (String(project.repositoryFullName || "").toLowerCase() !== requestedRepository.toLowerCase()) {
        throw new Error("The existing project belongs to a different repository. Review readiness again.");
      }
      if (existingProject && (project.services?.length !== services.length || services.some((service, index) => project.services?.[index]?.name !== service.name.trim() || project.services?.[index]?.serviceDirectory !== service.serviceDirectory.trim() || Number(project.services?.[index]?.servicePort || 8080) !== Number(service.servicePort)))) {
        throw new Error("This repository already has a different service configuration. Update its explicit services in Project Settings.");
      }
      if (services.length > 1) {
        const selectedIndex = services.findIndex((service) => service.key === applicationEntryPointServiceId);
        const selectedServiceId = project.services?.[selectedIndex]?.id;
        if (!selectedServiceId) throw new Error("Choose which service Open Application should open.");
        if (project.applicationEntryPointServiceId !== selectedServiceId) project = (await updateProject(project.id, { applicationEntryPointServiceId: selectedServiceId })).project;
      }
      if (project.targetBranch !== requestedBranch) {
        project = (await updateProjectBranch(project.id, requestedBranch)).project;
      }
      if (!isCurrent()) return;
      let savedCount = 0; const ignored = [];
      for (const [index, item] of parsedServices.entries()) {
        const persistedService = project.services?.[index];
        if (!persistedService) throw new Error("DeployGuard did not persist the configured service set.");
        if (item.parsed.entries.length) {
          const saved = await bulkUpsertProjectServiceEnvVars(project.id, persistedService.id, item.parsed.entries.map(({ key, value, isSecret }) => ({ key, value, isSecret, scope: "runtime" })));
          savedCount += saved.variables?.length || 0; ignored.push(...(saved.ignoredVariableNames || []));
        }
        ignored.push(...(item.parsed.ignoredVariableNames || []));
      }
      if (!isCurrent()) return;
      setSavedEnvironmentCount(savedCount); setIgnoredEnvironmentNames([...new Set(ignored)].sort());
      setServices((current) => current.map((service) => ({ ...service, envPaste: "" })));
      if (database.provider === "managed") {
        const attachedIndex = Math.max(0, services.findIndex((service) => service.key === database.attachedServiceKey));
        await updateProjectDatabaseTier(project.id, { provider: "managed", engine: database.engine, persistenceEnabled: true, attachedServiceId: project.services[attachedIndex].id });
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
      <div className="new-project-fields"><label className="field"><span>Authorized repository</span><select disabled={working === "deploy"} onChange={(event) => void chooseRepository(event.target.value)} value={repository}><option value="">Select a repository</option>{repositories.map((item) => <option key={item.id || item.fullName} value={item.fullName}>{item.fullName}</option>)}</select></label><label className="field"><span>Branch</span><select disabled={!repository || working === "deploy"} onChange={(event) => void changeBranch(event.target.value)} value={branch}><option value="">Select a branch</option>{branches.map((item) => <option key={item} value={item}>{item}</option>)}</select></label></div>
      <section className="deployable-services-editor"><div className="compact-section-heading"><div><p className="eyebrow">Services</p><h3>Applications to deploy</h3><p>Choose each runnable application explicitly. Railpack determines how it is built.</p></div><button className="secondary-button" disabled={Boolean(working) || services.length >= 20} onClick={addService} type="button">+ Add Service</button></div>
        {services.length > 1 ? <label className="field"><span>Application service</span><select disabled={Boolean(working)} onChange={(event) => changeApplicationService(event.target.value)} value={applicationEntryPointServiceId}><option value="">Choose the service Open Application should open</option>{services.map((service) => <option key={service.key} value={service.key}>{service.name} — {service.serviceDirectory || "Choose a directory"}</option>)}</select></label> : null}
        {parsedServices.map(({ service, parsed }, index) => <article className="panel-flat deployable-service-editor" key={service.key}><div className="compact-section-heading"><strong>Service {index + 1}</strong>{services.length > 1 ? <button className="danger-text-button" disabled={Boolean(working)} onClick={() => removeService(service.key)} type="button">Remove</button> : null}</div><div className="new-project-fields"><label className="field"><span>Name</span><input disabled={Boolean(working)} maxLength="80" onChange={(event) => changeService(service.key, "name", event.target.value)} value={service.name} /></label><label className="field"><span>Directory</span><select disabled={Boolean(working)} onChange={(event) => changeService(service.key, "serviceDirectory", event.target.value)} value={service.serviceDirectory}><option value="">Choose a directory</option>{rankedDirectories.map((directory) => <option key={directory} value={directory}>{directory === "." ? "Repository root (.)" : directory}</option>)}</select></label><label className="field"><span>Application Port</span><input disabled={Boolean(working)} inputMode="numeric" max="65535" min="1" onChange={(event) => changeService(service.key, "servicePort", event.target.value)} type="number" value={service.servicePort} /><small>Port this application listens on. Leave 8080 unless your application uses another port.</small></label></div><label className="field"><span>Optional .env for {service.name || `Service ${index + 1}`}</span><textarea disabled={Boolean(working)} onChange={(event) => changeService(service.key, "envPaste", event.target.value)} placeholder={"# Optional\nAPI_URL=https://example.test"} rows="5" value={service.envPaste} /><small>Encrypted and injected only into this service.</small></label>{parsed.errors.map((message) => <IssueCard key={message} severity="danger" title="Invalid environment input"><p>{message}</p></IssueCard>)}{parsed.warnings?.map((message) => <IssueCard key={message} severity="warning" title="Input ignored"><p>{message}</p></IssueCard>)}</article>)}
      </section>
      <section className="panel-flat settings-simple-form"><div><p className="eyebrow">Database</p><h3>Database</h3><p className="muted">Use existing ENV for an external database, or let DeployGuard manage one database for one service.</p></div><label className="field"><span>Database</span><select disabled={Boolean(working)} onChange={(event) => setDatabase((current) => event.target.value === "none" ? { ...current, provider: "none" } : { ...current, provider: "managed", engine: event.target.value })} value={database.provider === "managed" ? database.engine : "none"}><option value="none">No managed database / use existing ENV</option><option value="postgres">PostgreSQL</option><option value="mysql">MySQL</option><option value="mongodb">MongoDB</option></select></label>{database.provider === "managed" ? services.length > 1 ? <label className="field"><span>Attach database to</span><select disabled={Boolean(working)} onChange={(event) => setDatabase((current) => ({ ...current, attachedServiceKey: event.target.value }))} value={database.attachedServiceKey || services[0].key}>{services.map((service) => <option key={service.key} value={service.key}>{service.name}</option>)}</select></label> : <p className="muted">The database will connect to {services[0]?.name || "Web"}.</p> : null}{managedDatabaseConflicts.length ? <IssueCard severity="danger" title="Database configuration conflict"><p>Remove {managedDatabaseConflicts.join(", ")} from the selected service ENV, or choose “No managed database / use existing ENV”.</p></IssueCard> : null}</section>
      {ignoredEnvironmentNames.map((key) => <IssueCard key={key} severity="warning" title="Platform-managed value"><p>{key} is managed by DeployGuard and was ignored.</p></IssueCard>)}
      {savedEnvironmentCount ? <IssueCard severity="success" title="Application configuration saved"><p>{savedEnvironmentCount} value{savedEnvironmentCount === 1 ? " was" : "s were"} accepted; values are not displayed.</p></IssueCard> : null}
      {readiness ? <ReadinessSummary level={readiness.level} message={readiness.message} requiredInputs={readiness.requiredInputs}>
        <small>No source inspection or framework selection occurs before deployment.</small>
      </ReadinessSummary> : null}
      <ActionBar className="new-project-actions" label="Deployment actions"><button className="secondary-button" disabled={Boolean(working) || !repository || !branch || hasServiceErrors} onClick={() => void reviewReadiness()} type="button">{working === "review" ? "Saving…" : "Continue"}</button><button className="button" disabled={Boolean(working) || !deployable} onClick={() => void deploy()} type="button">{working === "deploy" ? "Starting deployment…" : "Deploy"}</button></ActionBar>
    </Card>}
  </div>;
}
