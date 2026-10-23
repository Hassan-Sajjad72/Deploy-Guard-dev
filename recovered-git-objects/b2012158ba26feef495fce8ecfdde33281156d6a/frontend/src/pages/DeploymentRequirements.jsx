import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { getDeploymentRequirements, getProject, resolveDeploymentRequirements } from "../api/projectApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { PageHeader } from "../components/common/Premium.jsx";
import EnvironmentVariablesPanel from "../components/projects/EnvironmentVariablesPanel.jsx";
import { useAuth } from "../hooks/useAuth.js";

const statusCopy = {
  detected: "Detected",
  needs_input: "Needs input",
  saved: "Saved",
  pending_deployment: "Configuration saved. It has not been applied to the running service yet.",
  applying: "Applying database configuration.",
  applied: "Applied to running service",
  verified: "Configuration applied and deployment verified.",
};

export default function DeploymentRequirements() {
  const { projectId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { logout } = useAuth();
  const [project, setProject] = useState(null);
  const [requirements, setRequirements] = useState(null);
  const [provider, setProvider] = useState("managed");
  const [databaseName, setDatabaseName] = useState("");
  const [external, setExternal] = useState({ host: "", port: "5432", user: "", password: "", databaseUrl: "", tlsRequired: true });
  const [externalInputMode, setExternalInputMode] = useState("url");
  const [values, setValues] = useState({});
  const [generate, setGenerate] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [authRequired, setAuthRequired] = useState(false);
  const [saved, setSaved] = useState(false);
  const focus = new URLSearchParams(location.search).get("focus");
  const focused = ["database", "secrets"].includes(focus);

  async function load() {
    setError(""); setAuthRequired(false);
    try {
      const [projectResponse, response] = await Promise.all([getProject(projectId), getDeploymentRequirements(projectId)]);
      setProject(projectResponse.project);
      setRequirements(response.requirements);
      const nextProvider = response.requirements.database?.provider || "managed";
      setProvider(nextProvider === "external" ? "external" : "managed");
      setExternal((current) => ({ ...current, port: response.requirements.database?.engine === "mysql" ? "3306" : "5432" }));
      setDatabaseName(response.requirements.database?.effectiveDatabaseName || response.requirements.database?.detectedDatabaseName || "");
    } catch (caught) {
      if (caught.status === 401) setAuthRequired(true);
      else setError(caught.message);
    }
  }
  useEffect(() => { void load(); }, [projectId]);

  const unresolved = useMemo(() => requirements?.requiredInputs?.filter((item) => !item.configured) || [], [requirements]);
  const visibleBlockers = useMemo(() => {
    const blockers = requirements?.blockers || [];
    if (focus === "database") return blockers.filter((item) => /database|postgres|mysql|localhost|DB_|DATABASE_URL/i.test(item));
    if (focus === "secrets") return blockers.filter((item) => /environment|variable|secret|DB_|DATABASE_URL|API_KEY|TOKEN|PASSWORD/i.test(item));
    return blockers;
  }, [focus, requirements]);
  function updateValue(key, value) { setValues((current) => ({ ...current, [key]: value })); }
  function updateExternal(key, value) { setExternal((current) => ({ ...current, [key]: value })); }

  async function submit(event) {
    event?.preventDefault();
    setBusy(true); setError(""); setAuthRequired(false); setSaved(false);
    try {
      const response = await resolveDeploymentRequirements(projectId, {
        databaseProvider: provider,
        databaseName: databaseName || undefined,
        externalHost: provider === "external" && externalInputMode === "structured" ? external.host : undefined,
        externalPort: provider === "external" && externalInputMode === "structured" ? Number(external.port || 5432) : undefined,
        externalTlsRequired: provider === "external" ? external.tlsRequired : undefined,
        values: {
          ...values,
          ...(provider === "external" && externalInputMode === "url" ? { DATABASE_URL: external.databaseUrl } : {}),
          ...(provider === "external" && externalInputMode === "structured" ? { DB_USER: external.user, DB_PASSWORD: external.password } : {}),
        },
        generate,
        saveAndResume: false,
        sourceCommit: requirements.sourceCommit,
        scanRevision: requirements.scanRevision,
      });
      setRequirements(response.requirements);
      setValues({}); setGenerate({}); setSaved(true);
    } catch (caught) {
      if (caught.status === 401) setAuthRequired(true);
      else setError(caught.message);
    } finally { setBusy(false); }
  }

  async function reauthenticate() {
    await logout().catch(() => undefined);
    navigate("/login", { state: { from: location } });
  }

  if (authRequired) return <div className="workspace-page requirements-page"><section className="panel-flat requirements-auth"><p className="eyebrow">Session confirmation</p><h1>Re-authentication required</h1><p>Your intended deployment requirements are preserved. Sign in again to continue securely.</p><button className="button" onClick={reauthenticate} type="button">Re-authenticate and continue</button></section></div>;
  if (!requirements && !error) return <div className="workspace-page"><LoadingState message="Preparing deployment requirements…" /></div>;
  if (!requirements) return <div className="workspace-page"><ErrorState message={error} onRetry={load} /></div>;

  const architecture = requirements.architecture || {};
  const databaseLabel = architecture.databaseEngine === "mysql" ? "MySQL" : "PostgreSQL";
  const canManage = project?.canManage !== false;
  const running = requirements.applicationStatus === "applying";
  return <div className="workspace-page requirements-page">
    <PageHeader eyebrow={focused ? "Directed fix" : "Application"} title={focus === "database" ? "Configure database" : "Environment"} description={focus === "database" ? "Choose the database connection used by this application." : "Manage required configuration, service bindings, and masked application variables in one place."} context={`${project?.repositoryFullName || "Repository"} · ${project?.targetBranch || "branch"}`} />
    {focused ? <section className="focused-settings-banner"><div><span>You are fixing</span><strong>{focus === "database" ? "Database setup required" : "Missing environment variables"}</strong></div><Link className="subtle-button" to={`/projects/${projectId}/requirements`}>Show all requirements</Link></section> : null}
    {error ? <ErrorState message={error} /> : null}
    <div className={`requirements-status status-${requirements.applicationStatus}`}><span>{statusCopy[requirements.applicationStatus] || requirements.status}</span><small>Scan {String(requirements.sourceCommit || "not available").slice(0, 8)}</small></div>
    {saved ? <section className="state success requirements-saved"><strong>Database configuration saved</strong><p>{requirements.applicationStatus === "pending_deployment" ? "Configuration saved. It has not been applied to the running service yet." : statusCopy[requirements.applicationStatus]}</p></section> : null}

    <form className="requirements-layout" onSubmit={submit}>
      <main className="requirements-main">
        {!focused ? <section className="panel-flat requirement-section">
          <p className="eyebrow">Application</p>
          <h2>Detected from this commit</h2>
          <ul className="requirements-checks">
            <li><span>✓</span><strong>{architecture.runtime || "Runtime"} / {architecture.framework || "web application"}</strong> detected</li>
            <li><span>✓</span><strong>Port {architecture.port || "automatic"}</strong> detected</li>
            {architecture.databaseRequired ? <li><span>✓</span><strong>{architecture.databaseEngine === "mysql" ? "MySQL" : "PostgreSQL"}</strong> dependency detected</li> : null}
          </ul>
        </section> : null}

        {architecture.databaseRequired && focus !== "secrets" ? <section className={`panel-flat requirement-section ${focus === "database" ? "is-focused" : ""}`}>
          <p className="eyebrow">Database</p><h2>Choose the database connection</h2>
          <label className={`requirements-choice ${provider === "managed" ? "selected" : ""}`}><input checked={provider === "managed"} disabled={!canManage || busy} name="database-provider" onChange={() => setProvider("managed")} type="radio" /><span><strong>DeployGuard-managed {databaseLabel}</strong><small>Recommended · private service binding and persistent encrypted storage included</small></span></label>
          <label className={`requirements-choice ${provider === "external" ? "selected" : ""}`}><input checked={provider === "external"} disabled={!canManage || busy} name="database-provider" onChange={() => setProvider("external")} type="radio" /><span><strong>External {databaseLabel}</strong><small>Use a database endpoint that the application can reach</small></span></label>
          {provider === "external" ? <div>
            <div className="requirements-provider-tabs" role="tablist">
              <button aria-selected={externalInputMode === "url"} className={externalInputMode === "url" ? "selected" : ""} onClick={() => setExternalInputMode("url")} role="tab" type="button">Connection URL</button>
              <button aria-selected={externalInputMode === "structured"} className={externalInputMode === "structured" ? "selected" : ""} onClick={() => setExternalInputMode("structured")} role="tab" type="button">Advanced fields</button>
            </div>
            {externalInputMode === "url" ? <label className="field"><span>DATABASE_URL</span><input disabled={!canManage || busy} onChange={(event) => updateExternal("databaseUrl", event.target.value)} placeholder="postgresql://…" required type="password" value={external.databaseUrl} /></label> : <div className="requirements-external-grid"><label className="field"><span>Database host</span><input disabled={!canManage || busy} onChange={(event) => updateExternal("host", event.target.value)} required value={external.host} /></label><label className="field"><span>Port</span><input disabled={!canManage || busy} min="1" max="65535" onChange={(event) => updateExternal("port", event.target.value)} type="number" value={external.port} /></label><label className="field"><span>Database user</span><input disabled={!canManage || busy} onChange={(event) => updateExternal("user", event.target.value)} required value={external.user} /></label><label className="field"><span>Database password</span><input disabled={!canManage || busy} onChange={(event) => updateExternal("password", event.target.value)} required type="password" value={external.password} /></label></div>}
            <label><input checked={external.tlsRequired} disabled={!canManage || busy} onChange={(event) => updateExternal("tlsRequired", event.target.checked)} type="checkbox" /> Require TLS for the external connection</label>
          </div> : <div className="requirements-included"><span>✓ Persistent encrypted storage included</span><span>✓ Private database network included</span></div>}
          <details className="requirements-advanced"><summary>Advanced options</summary><label className="field"><span>Database name</span><input disabled={!canManage || busy} onChange={(event) => setDatabaseName(event.target.value)} value={databaseName} /></label><p>Prefilled from repository analysis. DeployGuard generates the database user, password, hostname, and connection URL.</p></details>
        </section> : null}

        {focus !== "database" ? <section className={`panel-flat requirement-section ${focus === "secrets" ? "is-focused" : ""}`}>
          <div className="requirements-section-heading"><div><p className="eyebrow">Required configuration</p><h2>{unresolved.length} item{unresolved.length === 1 ? "" : "s"} remaining</h2></div></div>
          {requirements.requiredInputs.length ? <div className="requirements-input-list">{requirements.requiredInputs.map((input) => <label className="requirement-input" key={input.key}><span><strong>{input.key}</strong><small>{input.description}</small><em>{input.configured ? "Saved · value remains masked" : `${input.owner.replaceAll("_", " ")} · ${input.scope}`}</em></span>{input.configured ? <output>••••••••</output> : <div><input disabled={!canManage || busy || generate[input.key]} onChange={(event) => updateValue(input.key, event.target.value)} required={!generate[input.key]} type={input.secret ? "password" : "text"} value={values[input.key] || ""} />{input.secret ? <button className="subtle-button" disabled={!canManage || busy} onClick={() => setGenerate((current) => ({ ...current, [input.key]: !current[input.key] }))} type="button">{generate[input.key] ? "Secure value will be generated" : "Generate secure value"}</button> : null}</div>}</label>)}</div> : <div className="requirements-complete">✓ All required application configuration is complete.</div>}
        </section> : null}

        {visibleBlockers.length ? <section className="state warning"><strong>Deployment is not ready yet</strong><ul>{visibleBlockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></section> : null}
        {canManage ? <div className="requirements-actions"><button className="button" disabled={busy || running} type="submit">{busy ? "Saving requirements…" : "Save requirements"}</button><p>Saving configuration never starts deployment. Return to Overview and use the single Deploy or Redeploy action when ready.</p><Link className="subtle-button" to={`/projects/${projectId}`}>Return to Overview</Link></div> : null}
      </main>

      <aside className="requirements-side">
        <section className="panel-flat"><p className="eyebrow">After save</p><h3>DeployGuard will</h3><ol><li>Validate the canonical configuration.</li><li>Refresh deployment preflight evidence.</li><li>Wait for your explicit Deploy action.</li></ol></section>
        <Link className="subtle-button" to={`/projects/${projectId}/settings`}>Open advanced project settings</Link>
      </aside>
    </form>
    <EnvironmentVariablesPanel canManage={canManage} projectId={projectId} />
  </div>;
}
