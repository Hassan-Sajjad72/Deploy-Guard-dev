import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { bulkUpsertProjectServiceEnvVars, connectGithubAppInstallation, createProject, deployGithubActionsDeployment, getGithubConnectionStatus, getGithubRepositories, getGithubRepositoryDirectories, inspectGithubRepository, updateProject, updateProjectBranch, updateProjectDatabaseTier } from "../api/projectApi.js";
import { Button, Callout, PageHeader } from "../components/common/DesignSystem.jsx";
import AppIcon from "../components/common/AppIcon.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { managedDatabaseAliases } from "../utils/envOwnership.js";
import { parseEnvPaste } from "../utils/envPaste.js";
import { createDeploymentSelectionGate, deploymentSelectionKey } from "../utils/deploymentSelection.js";

const DATABASE_NAMES = { postgres: "PostgreSQL", mysql: "MySQL", mongodb: "MongoDB" };

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
  return [
    { label: "Source", detail: hasRepository && hasBranch ? `${repository} · ${branch}` : "Repository and branch", state: hasRepository && hasBranch ? "complete" : "current" },
    { label: "Services", detail: hasBranch ? "Directories and variables" : "Waiting for source", state: hasReadiness ? "complete" : hasBranch ? "current" : "waiting" },
    { label: "Configuration", detail: hasReadiness ? "Saved" : "Database", state: hasReadiness ? "complete" : hasBranch ? "current" : "waiting" },
    { label: "Review & Deploy", detail: working === "deploy" ? "Starting" : deployable ? "Ready" : "Not reviewed", state: working === "deploy" ? "current" : deployable ? "ready" : "waiting" },
  ];
}

function directoryLeaf(directory) {
  return directory === "." ? "Repository root" : directory.split("/").at(-1);
}

function buildDirectoryTree(directories) {
  const root = { path: ".", children: new Map() };
  for (const directory of directories) {
    if (directory === ".") continue;
    let node = root;
    let path = "";
    for (const segment of directory.split("/")) {
      path = path ? `${path}/${segment}` : segment;
      if (!node.children.has(segment)) node.children.set(segment, { path, children: new Map() });
      node = node.children.get(segment);
    }
  }
  function serialize(node) {
    return [...node.children.values()].sort((left, right) => directoryLeaf(left.path).localeCompare(directoryLeaf(right.path), undefined, { sensitivity: "base" })).map((child) => ({ ...child, children: serialize(child) }));
  }
  return serialize(root);
}

function filterDirectoryTree(nodes, search) {
  if (!search) return nodes;
  return nodes.flatMap((node) => {
    const children = filterDirectoryTree(node.children, search);
    return node.path.toLocaleLowerCase().includes(search) || children.length ? [{ ...node, children }] : [];
  });
}

function DirectoryTreeNodes({ expandedDirectories, nodes, onSelect, onToggle, searching, selectedDirectory }) {
  return nodes.map((node) => {
    const hasChildren = node.children.length > 0;
    const expanded = searching || expandedDirectories.has(node.path);
    return <li aria-expanded={hasChildren ? expanded : undefined} aria-selected={node.path === selectedDirectory} className="service-directory-tree-item" key={node.path} role="treeitem">
      <div className="service-directory-tree-row">
        {hasChildren ? <button aria-label={`${expanded ? "Collapse" : "Expand"} ${directoryLeaf(node.path)}`} className="service-directory-tree-toggle" onClick={() => onToggle(node.path)} type="button"><AppIcon name={expanded ? "chevron-down" : "chevron"} size={14} /></button> : <span aria-hidden="true" className="service-directory-tree-spacer" />}
        <button className="service-directory-tree-directory" data-directory={node.path} onClick={() => onSelect(node.path)} type="button">{directoryLeaf(node.path)}</button>
      </div>
      {hasChildren && expanded ? <ul role="group"><DirectoryTreeNodes expandedDirectories={expandedDirectories} nodes={node.children} onSelect={onSelect} onToggle={onToggle} searching={searching} selectedDirectory={selectedDirectory} /></ul> : null}
    </li>;
  });
}

function ServiceDirectoryPicker({ browseError, browsing, directories, disabled, onValueChange, service }) {
  const inputRef = useRef(null);
  const [expandedDirectories, setExpandedDirectories] = useState(() => new Set(["."]));
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const helpId = `service-directory-help-${service.key}`;
  const treeId = `service-directory-tree-${service.key}`;
  const suggestionsAvailable = !browsing && !browseError;
  const directoryTree = useMemo(() => buildDirectoryTree(directories), [directories]);
  const search = searchQuery.trim().toLocaleLowerCase();
  const visibleTree = useMemo(() => filterDirectoryTree(directoryTree, search), [directoryTree, search]);

  useEffect(() => {
    setExpandedDirectories(new Set(["."]));
    setSearchQuery("");
    setOpen(false);
  }, [directories]);

  useEffect(() => {
    if (browsing || browseError) setOpen(false);
    else if (document.activeElement === inputRef.current) setOpen(true);
  }, [browseError, browsing]);

  function selectDirectory(directory) {
    onValueChange(directory);
    setSearchQuery("");
    setOpen(false);
  }

  function toggleDirectory(directory) {
    setExpandedDirectories((current) => {
      const next = new Set(current);
      if (next.has(directory)) next.delete(directory);
      else next.add(directory);
      return next;
    });
  }

  function handleSearchKeyDown(event) {
    if (event.key === "Escape") {
      setOpen(false);
    }
  }

  return <div className="field service-directory-field" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <span>Directory</span>
    <div className="service-directory-combobox">
      <input aria-autocomplete="list" autoComplete="off" name="serviceDirectory" aria-controls={treeId} aria-describedby={helpId} aria-expanded={open && suggestionsAvailable} aria-label="Directory" disabled={disabled} maxLength="512" onChange={(event) => { if (browseError) onValueChange(event.target.value); else { setSearchQuery(event.target.value); setOpen(true); } }} onClick={() => { if (suggestionsAvailable) setOpen(true); }} onFocus={() => { if (suggestionsAvailable) setOpen(true); }} onKeyDown={handleSearchKeyDown} placeholder={browseError ? "Repository-relative directory" : "Search repository directories"} ref={inputRef} role="combobox" value={browseError ? service.serviceDirectory : open ? searchQuery : service.serviceDirectory} />
      {open && suggestionsAvailable && !disabled ? <ul aria-label="Repository directories" className="service-directory-tree" id={treeId} role="tree"><li aria-expanded="true" aria-selected={service.serviceDirectory === "."} className="service-directory-tree-item" role="treeitem"><div className="service-directory-tree-row"><span aria-hidden="true" className="service-directory-tree-spacer" /><button className="service-directory-tree-directory" data-directory="." onClick={() => selectDirectory(".")} type="button">Repository root</button></div><ul role="group"><DirectoryTreeNodes expandedDirectories={expandedDirectories} nodes={visibleTree} onSelect={selectDirectory} onToggle={toggleDirectory} searching={Boolean(search)} selectedDirectory={service.serviceDirectory} /></ul></li></ul> : null}
    </div>
    <small className="field-hint" id={helpId}>{browsing ? "Loading directories…" : browseError ? "Folder suggestions are unavailable. Type the path relative to the repository root." : "The folder that contains this service's code. Use the repository root for single-app repositories."}</small>
  </div>;
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
  const [services, setServices] = useState([{ key: crypto.randomUUID(), name: "Web", serviceDirectory: "", envPaste: "" }]);
  const [applicationEntryPointServiceId, setApplicationEntryPointServiceId] = useState("");
  const [directories, setDirectories] = useState(["."]);
  const [directoryBrowseError, setDirectoryBrowseError] = useState("");
  const [directoriesLoading, setDirectoriesLoading] = useState(false);
  const [database, setDatabase] = useState({ provider: "none", engine: "postgres", attachedServiceKey: "" });
  const [readiness, setReadiness] = useState(null);
  const [savedEnvironmentCount, setSavedEnvironmentCount] = useState(0);
  const [ignoredEnvironmentNames, setIgnoredEnvironmentNames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState("");
  const attachedDatabaseServiceKey = database.attachedServiceKey || services[0]?.key;
  const parsedServices = useMemo(() => services.map((service) => ({
    service,
    parsed: parseEnvPaste(service.envPaste, database.provider === "managed" && service.key === attachedDatabaseServiceKey ? managedDatabaseAliases(database.engine) : []),
  })), [attachedDatabaseServiceKey, database.engine, database.provider, services]);
  const hasServiceErrors = parsedServices.some(({ parsed }) => parsed.errors.length) || services.some((service) => !service.name.trim() || !service.serviceDirectory.trim()) || new Set(services.map((service) => service.name.trim().toLowerCase())).size !== services.length || (services.length > 1 && !services.some((service) => service.key === applicationEntryPointServiceId));
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
    setDirectoryBrowseError("");
    setDirectoriesLoading(false);
    setServices((current) => current.map((service) => ({ ...service, serviceDirectory: "" })));
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
        setDirectoriesLoading(true);
        try {
          const response = await getGithubRepositoryDirectories(value, nextBranch);
          if (!selectionGate.current.isCurrent(directoryTicket)) return;
          setDirectories(response.directories || ["."]);
        } catch (caught) {
          if (!selectionGate.current.isCurrent(directoryTicket)) return;
          setDirectoryBrowseError(safeMessage(caught));
        } finally {
          if (selectionGate.current.isCurrent(directoryTicket)) setDirectoriesLoading(false);
        }
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
    setDirectoryBrowseError("");
    setDirectoriesLoading(Boolean(repository && value));
    if (repository && value) {
      try {
        const response = await getGithubRepositoryDirectories(repository, value);
        if (!selectionGate.current.isCurrent(directoryTicket)) return;
        setDirectories(response.directories || ["."]);
      } catch (caught) {
        if (selectionGate.current.isCurrent(directoryTicket)) setDirectoryBrowseError(safeMessage(caught));
      } finally {
        if (selectionGate.current.isCurrent(directoryTicket)) setDirectoriesLoading(false);
      }
    }
  }

  function changeService(key, field, value) {
    setServices((current) => current.map((service) => service.key === key ? { ...service, [field]: value } : service));
    if (readiness) setReadiness(null);
  }

  function addService() {
    setServices((current) => [...current, { key: crypto.randomUUID(), name: `Service ${current.length + 1}`, serviceDirectory: "", envPaste: "" }]);
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
    let existingProjectSettingsId = null;
    try {
      let project; let existingProject = false;
      try {
        project = (await createProject({ repositoryFullName: requestedRepository, targetBranch: requestedBranch, name: requestedRepository.split("/").pop(), applicationEntryPointServiceId: services.length === 1 ? services[0].key : applicationEntryPointServiceId, services: services.map(({ key, name, serviceDirectory }) => ({ id: key, name, serviceDirectory })) })).project;
      } catch (caught) {
        if (caught.code === "EXISTING_PROJECT" || caught.payload?.code === "EXISTING_PROJECT") { project = caught.payload.existingProject; existingProject = true; }
        else throw caught;
      }
      if (!isCurrent()) return;
      if (String(project.repositoryFullName || "").toLowerCase() !== requestedRepository.toLowerCase()) {
        throw new Error("The existing project belongs to a different repository. Review readiness again.");
      }
      if (existingProject && (project.services?.length !== services.length || services.some((service, index) => project.services?.[index]?.name !== service.name.trim() || project.services?.[index]?.serviceDirectory !== service.serviceDirectory.trim()))) {
        existingProjectSettingsId = project.id;
        throw new Error("This repository already has a different service configuration. Service name or directory changes must be made under Settings → Services.");
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
      if (database.provider === "managed") {
        const attachedIndex = Math.max(0, services.findIndex((service) => service.key === attachedDatabaseServiceKey));
        await updateProjectDatabaseTier(project.id, { provider: "managed", engine: database.engine, persistenceEnabled: true, attachedServiceId: project.services[attachedIndex].id });
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
      setReadiness({ level: "ready", deployAllowed: true, requiredInputs: [], message: "Repository, branch, and optional environment are ready for deployment.", project, selection: ticket.selection });
    } catch (caught) {
      if (isCurrent()) setReadiness({ level: "blocked", message: safeMessage(caught), selection: ticket.selection, existingProjectSettingsId });
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

  if (loading) return <LoadingState message="Checking GitHub access…" />;

  const stepState = (index) => journey[index]?.state || "waiting";
  const StepHead = ({ index, id, title, description, action }) => <header className="np-step-head"><span aria-hidden="true" className={`np-step-mark is-${stepState(index)}`}>{stepState(index) === "complete" ? <AppIcon name="check" size={13} /> : index + 1}</span><div><h2 id={id}>{title}</h2>{description ? <p>{description}</p> : null}</div>{action}</header>;
  return <div className="page page-narrow deploy-page">
    <PageHeader description="Pick a repository and branch, set up its services, then deploy. You can change any of this later in Settings." title="Deploy a repository" />
    {!status?.connected ? <section className="panel panel-pad np-connect">
      <span aria-hidden="true" className="empty-icon"><AppIcon name="github" size={22} /></span>
      <div><h2>Connect GitHub</h2><p>{status?.message || "Install the DeployGuard GitHub App on the account or organization that owns your repository. DeployGuard only sees the repositories you grant."}</p></div>
      <div className="actions">{status?.availableInstallations?.map((item) => <button className="btn btn-primary" key={item.installationId} onClick={() => void connectGithubAppInstallation(item.installationId).then(refresh).catch((caught) => setReadiness({ level: "blocked", message: safeMessage(caught) }))} type="button">Connect {item.accountLogin}</button>)}{status?.installUrl ? <a className="btn" href={status.installUrl}>Install GitHub App</a> : null}</div>
      {readiness?.level === "blocked" ? <Callout tone="danger"><p>{readiness.message}</p></Callout> : null}
    </section> : <div className="new-project-form np-flow">
      <ol aria-label="Deployment readiness journey" className="np-journey sr-only">{journey.map((step, index) => <li className={`is-${step.state}`} key={step.label}><span aria-hidden="true">{step.state === "complete" ? <AppIcon name="check" size={12} /> : index + 1}</span><strong>{step.label}</strong></li>)}</ol>

      <section aria-labelledby="np-source" className="panel np-step">
        <StepHead description="Only repositories you granted to the DeployGuard GitHub App are listed." id="np-source" index={0} title="Source" />
        <div className="field-row"><label className="field"><span>Repository</span><select disabled={working === "deploy"} name="repository" onChange={(event) => void chooseRepository(event.target.value)} value={repository}><option value="">Select a repository</option>{repositories.map((item) => <option key={item.id || item.fullName} value={item.fullName}>{item.fullName}</option>)}</select></label><label className="field"><span>Branch</span><select disabled={!repository || working === "deploy"} name="branch" onChange={(event) => void changeBranch(event.target.value)} value={branch}><option value="">{repository ? "Select a branch" : "Choose a repository first"}</option>{branches.map((item) => <option key={item} value={item}>{item}</option>)}</select></label></div>
      </section>

      <section aria-labelledby="np-services" className="panel np-step deployable-services-editor">
        <StepHead action={<Button disabled={Boolean(working) || services.length >= 20} icon="plus" onClick={addService} size="sm">Add service</Button>} description="One service per runnable app. Monorepos can add several. Builds and ports are detected automatically." id="np-services" index={1} title="Services" />
        {services.length > 1 ? <label className="field np-public"><span>Public service</span><select disabled={Boolean(working)} name="applicationService" onChange={(event) => changeApplicationService(event.target.value)} value={applicationEntryPointServiceId}><option value="">Choose the service your URL opens</option>{services.map((service) => <option key={service.key} value={service.key}>{service.name} — {service.serviceDirectory || "choose a directory"}</option>)}</select></label> : null}
        {parsedServices.map(({ service, parsed }, index) => <article className="deployable-service-editor np-service" key={service.key}>
          <div className="np-service-head"><strong>{services.length > 1 ? `Service ${index + 1}` : "Service"}</strong>{services.length > 1 ? <Button disabled={Boolean(working)} onClick={() => removeService(service.key)} size="sm" tone="ghost">Remove</Button> : null}</div>
          <div className="field-row"><label className="field"><span>Name</span><input autoComplete="off" disabled={Boolean(working)} maxLength="80" name="serviceName" onChange={(event) => changeService(service.key, "name", event.target.value)} value={service.name} /></label><ServiceDirectoryPicker browseError={directoryBrowseError} browsing={directoriesLoading} directories={directories} disabled={Boolean(working)} onValueChange={(value) => changeService(service.key, "serviceDirectory", value)} service={service} /></div>
          <details className="dg-np-service-env disclosure"><summary>Environment variables <span className="summary-meta">Optional</span></summary><div className="disclosure-body"><label className="field"><span>Paste a .env file for {service.name || `service ${index + 1}`}</span><textarea autoComplete="off" disabled={Boolean(working)} name="serviceEnvironment" onChange={(event) => changeService(service.key, "envPaste", event.target.value)} placeholder={"# Optional\nAPI_URL=https://example.test"} rows="5" spellCheck={false} value={service.envPaste} /><small className="field-hint">Encrypted and injected only into this service. PORT and HOST are set for you.</small></label></div></details>
          {parsed.errors.map((message) => <Callout key={message} title="Fix this line" tone="danger"><p>{message}</p></Callout>)}{parsed.warnings?.map((message) => <Callout key={message} tone="warning"><p>{message}</p></Callout>)}
        </article>)}
      </section>

      <section aria-labelledby="np-database" className="panel np-step">
        <StepHead description="DeployGuard can run one database for you, or your app can keep using its own." id="np-database" index={2} title="Database" />
        <div className="field-row"><label className="field"><span>Database</span><select disabled={Boolean(working)} name="databaseEngine" onChange={(event) => setDatabase((current) => event.target.value === "none" ? { ...current, provider: "none" } : { ...current, provider: "managed", engine: event.target.value })} value={database.provider === "managed" ? database.engine : "none"}><option value="none">None — my app uses its own database</option><option value="postgres">PostgreSQL (managed)</option><option value="mysql">MySQL (managed)</option><option value="mongodb">MongoDB (managed)</option></select><small className="field-hint">{database.provider === "managed" ? "DeployGuard runs it on persistent storage and connects it for you." : "Your app uses whatever connection variables you provide, such as DATABASE_URL."}</small></label>{database.provider === "managed" && services.length > 1 ? <label className="field"><span>Connect to</span><select disabled={Boolean(working)} name="databaseService" onChange={(event) => setDatabase((current) => ({ ...current, attachedServiceKey: event.target.value }))} value={database.attachedServiceKey || services[0].key}>{services.map((service) => <option key={service.key} value={service.key}>{service.name}</option>)}</select></label> : null}</div>
        {database.provider === "managed" && ["mysql", "mongodb"].includes(database.engine) ? <Callout tone="warning"><p>{DATABASE_NAMES[database.engine]} has not yet completed live AWS certification. PostgreSQL is the proven option.</p></Callout> : null}
        {database.provider === "managed" && services.length === 1 ? <p className="field-hint">The database connects to {services[0]?.name || "Web"}. Database variables you pasted for that service are managed by DeployGuard and will be ignored.</p> : null}
      </section>

      <section aria-labelledby="np-review" className="panel np-step dg-np-review">
        <StepHead description={deployable ? "Everything is saved. Deploying starts the build on GitHub Actions; you can follow it live." : "Continue saves this configuration and checks it is ready to deploy."} id="np-review" index={3} title="Review & deploy" />
        {ignoredEnvironmentNames.map((key) => <Callout key={key} tone="warning"><p><span className="mono">{key}</span> is managed by DeployGuard and was ignored.</p></Callout>)}
        {savedEnvironmentCount ? <Callout tone="success"><p>{savedEnvironmentCount} environment value{savedEnvironmentCount === 1 ? " was" : "s were"} saved; values are not displayed.</p></Callout> : null}
        {deployable ? <dl className="deploy-review-summary facts-list" aria-label="Deployment review"><div><dt>Source</dt><dd>{repository} · {branch}</dd></div><div><dt>Services</dt><dd>{services.map((service) => `${service.name} (${service.serviceDirectory})`).join(", ")}</dd></div><div><dt>Ports</dt><dd>Detected automatically from each service</dd></div><div><dt>Public service</dt><dd>{services.length === 1 ? services[0].name : services.find((service) => service.key === applicationEntryPointServiceId)?.name || "—"}</dd></div><div><dt>Database</dt><dd>{database.provider === "managed" ? `${DATABASE_NAMES[database.engine] || database.engine} (managed), connected to ${services.find((service) => service.key === attachedDatabaseServiceKey)?.name || "—"}` : "Your own, through environment variables"}</dd></div></dl> : null}
        {readiness && readiness.level !== "ready" ? <Callout actions={readiness.existingProjectSettingsId ? <Link className="btn btn-sm" to={`/projects/${readiness.existingProjectSettingsId}/settings`}>Open Project Settings</Link> : null} title={readiness.level === "warning" ? "Ready, with warnings" : readiness.level === "input_required" ? "More configuration is needed" : "This can't be deployed yet"} tone={readiness.level === "warning" || readiness.level === "input_required" ? "warning" : "danger"}><p>{readiness.message}</p>{readiness.requiredInputs?.length ? <p>Provide: {readiness.requiredInputs.join(", ")}.</p> : null}</Callout> : null}
        <div aria-label="Deployment actions" className="actions actions-end np-actions" role="group">{deployable ? <button aria-busy={working === "deploy" || undefined} className="button btn btn-primary" disabled={Boolean(working)} onClick={() => void deploy()} type="button"><AppIcon name="deploy" size={16} />{working === "deploy" ? "Starting deployment…" : "Deploy"}</button> : <button aria-busy={working === "review" || undefined} className="button btn btn-primary" disabled={Boolean(working) || !repository || !branch || hasServiceErrors} onClick={() => void reviewReadiness()} type="button">{working === "review" ? "Saving…" : "Continue"}</button>}</div>
      </section>
    </div>}
  </div>;
}
