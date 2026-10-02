import { useEffect, useState } from "react";
import {
  bulkUpsertProjectEnvVars,
  createProjectEnvVar,
  deleteProjectEnvVar,
  getProjectEnvVars,
  updateProjectEnvVar,
  bulkUpsertProjectServiceEnvVars, createProjectServiceEnvVar, deleteProjectServiceEnvVar, getProjectServiceEnvVars, updateProjectServiceEnvVar,
} from "../../api/projectApi.js";
import { parseEnvText } from "../../utils/envFileParser.js";
import { Button, Callout, Disclosure, Modal } from "../common/DesignSystem.jsx";
import EnvVarForm from "./EnvVarForm.jsx";
import EnvVarTable from "./EnvVarTable.jsx";

const emptyForm = { id: "", key: "", value: "", isSecret: true, scope: "runtime", isRequired: false, detectedSource: "User supplied" };

export default function EnvironmentVariablesPanel({ projectId, serviceId, serviceName, canManage, onSaved }) {
  const [setup, setSetup] = useState({ variables: [], managedVariables: [], reservedVariables: [] });
  const [form, setForm] = useState(emptyForm);
  const [paste, setPaste] = useState("");
  const [pasteResult, setPasteResult] = useState({ entries: [], errors: [], warnings: [] });
  const [modalOpen, setModalOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [ignoredEnvironmentNames, setIgnoredEnvironmentNames] = useState([]);
  const [pendingDelete, setPendingDelete] = useState(null);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const response = serviceId ? await getProjectServiceEnvVars(projectId, serviceId) : await getProjectEnvVars(projectId);
      setSetup({ variables: response.variables || [], managedVariables: response.managedVariables || [], reservedVariables: response.reservedVariables || [] });
    } catch (caught) {
      setError(caught.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [projectId, serviceId]);

  async function saveBulk(entries, clientIgnored = []) {
    if (!entries.length) return;
    if (entries.some((item) => !String(item.value || "").length)) {
      setError("Enter a value for every variable before saving.");
      return;
    }
    setBusy(true); setError(""); setSuccess("");
    try {
      const response = serviceId ? await bulkUpsertProjectServiceEnvVars(projectId, serviceId, entries) : await bulkUpsertProjectEnvVars(projectId, entries);
      setIgnoredEnvironmentNames([...new Set([...clientIgnored, ...(response.ignoredVariableNames || [])])].sort());
      setPaste(""); setPasteResult({ entries: [], errors: [], warnings: [] }); setModalOpen(false);
      const savedCount = response.variables?.length || 0;
      setSuccess(`${savedCount} environment variable${savedCount === 1 ? "" : "s"} saved. Values are now masked.`);
      await load();
      if (onSaved) await onSaved();
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  }

  function parsePaste(value) {
    setPaste(value);
    const parsed = parseEnvText(value, [], setup.reservedVariables.map((item) => item.key));
    setPasteResult(parsed);
  }

  async function submitSingle(event) {
    event.preventDefault(); setBusy(true); setError(""); setSuccess("");
    try {
      const payload = { key: form.key.trim().toUpperCase(), value: form.value || undefined, isSecret: form.isSecret, scope: form.scope, isRequired: form.isRequired, detectedSource: form.detectedSource };
      const response = form.id
        ? serviceId ? await updateProjectServiceEnvVar(projectId, serviceId, form.id, payload) : await updateProjectEnvVar(projectId, form.id, payload)
        : serviceId ? await createProjectServiceEnvVar(projectId, serviceId, payload) : await createProjectEnvVar(projectId, payload);
      setForm(emptyForm);
      setSuccess("Environment variable saved. Its value is now masked.");
      await load();
      if (onSaved) await onSaved();
    } catch (caught) {
      setError(caught.message);
    } finally { setBusy(false); }
  }

  async function remove(id) {
    setBusy(true); setError("");
    try { serviceId ? await deleteProjectServiceEnvVar(projectId, serviceId, id) : await deleteProjectEnvVar(projectId, id); setPendingDelete(null); await load(); setSuccess("Environment variable deleted."); }
    catch (caught) { setError(caught.message); }
    finally { setBusy(false); }
  }

  function edit(variable) {
    setForm({ ...emptyForm, ...variable, value: "" });
    setModalOpen(true);
  }

  return <section className="environment-manager">
    <div className="section-head"><div><h2>Environment variables</h2><p>Values apply only to {serviceName || "this service"}. Secrets stay hidden after saving.</p></div>{canManage ? <Button icon="plus" onClick={() => { setForm(emptyForm); setModalOpen(true); }} tone="primary">Add variable</Button> : null}</div>
    {error ? <Callout tone="danger">{error}</Callout> : null}
    {success ? <Callout tone="success">{success}</Callout> : null}
    {ignoredEnvironmentNames.map((key) => <Callout key={key} tone="warning"><p><span className="mono">{key}</span> is managed by DeployGuard and was ignored.</p></Callout>)}
    {loading ? <p className="muted">Loading environment variables…</p> : null}
    {!loading && setup.variables.length ? <EnvVarTable canManage={canManage} onDelete={(id) => setPendingDelete(setup.variables.find((variable) => variable.id === id) || { id })} onEdit={edit} variables={setup.variables} /> : !loading ? <p className="muted env-empty">No variables yet.{canManage ? " Add one, or import a .env file below." : ""}</p> : null}
    {!loading && canManage ? <details className="environment-import disclosure"><summary>Import a .env file</summary><div className="disclosure-body"><label className="field"><span>Paste KEY=VALUE lines</span><textarea autoComplete="off" name="environmentVariables" onChange={(event) => parsePaste(event.target.value)} placeholder={'APP_BASE_URL=https://example.test\nFEATURE_FLAG=true\nJWT_SECRET="replace-me"'} rows="7" spellCheck={false} value={paste} /></label>{pasteResult.errors.map((message) => <p className="field-error" key={message}>{message}</p>)}{pasteResult.warnings.map((message) => <p className="field-hint" key={message}>{message}</p>)}<div className="actions"><Button aria-busy={busy || undefined} disabled={busy || !pasteResult.entries.length || Boolean(pasteResult.errors.length)} onClick={() => saveBulk(pasteResult.entries, pasteResult.ignoredVariableNames || [])} tone="primary">{busy ? "Saving…" : `Save ${pasteResult.entries.length || ""} variable${pasteResult.entries.length === 1 ? "" : "s"}`.replace("  ", " ")}</Button><span className="field-hint">Blank lines are ignored; duplicate names are rejected.</span></div></div></details> : null}
    {!loading && setup.managedVariables.length ? <Disclosure meta={`${setup.managedVariables.length}`} summary="Managed by DeployGuard"><p className="muted env-managed-note">These names are set by the platform (for example the port, and database connection details when a managed database is attached). Their values cannot be viewed or edited.</p><EnvVarTable canManage={false} managed variables={setup.managedVariables} /></Disclosure> : null}
    {modalOpen ? <Modal className="environment-modal" labelledBy="environment-variable-dialog-title" onClose={() => { if (!busy) { setModalOpen(false); setForm(emptyForm); } }}><div><h2 id="environment-variable-dialog-title">{form.id ? "Edit variable" : "Add variable"}</h2><p>Database aliases are accepted unless a managed database owns them.</p></div><EnvVarForm form={form} isSubmitting={busy} onCancel={() => { setModalOpen(false); setForm(emptyForm); }} onChange={(event) => { const { checked, name, type, value } = event.target; setForm((current) => ({ ...current, [name]: type === "checkbox" ? checked : value })); }} onSubmit={async (event) => { await submitSingle(event); setModalOpen(false); }} submitLabel={form.id ? "Save variable" : "Add variable"} /></Modal> : null}
    {pendingDelete ? <Modal labelledBy="environment-delete-title" onClose={() => { if (!busy) setPendingDelete(null); }}><h2 id="environment-delete-title">Delete {pendingDelete.key ? <span className="mono">{pendingDelete.key}</span> : "this variable"}?</h2><p>The next deployment of {serviceName || "this service"} will start without it.</p><div className="dialog-actions"><Button disabled={busy} onClick={() => setPendingDelete(null)} tone="ghost">Cancel</Button><Button aria-busy={busy || undefined} disabled={busy} onClick={() => void remove(pendingDelete.id)} tone="danger-solid">Delete variable</Button></div></Modal> : null}
  </section>;
}
