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
import { Modal } from "../common/DesignSystem.jsx";
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
    if (!window.confirm("Delete this environment variable?")) return;
    setBusy(true); setError("");
    try { serviceId ? await deleteProjectServiceEnvVar(projectId, serviceId, id) : await deleteProjectEnvVar(projectId, id); await load(); setSuccess("Environment variable deleted."); }
    catch (caught) { setError(caught.message); }
    finally { setBusy(false); }
  }

  function edit(variable) {
    setForm({ ...emptyForm, ...variable, value: "" });
    setModalOpen(true);
  }

  return <section className="environment-manager panel-flat">
    <div className="environment-manager-header"><div><h2>Environment variables</h2><p>Values apply only to {serviceName || "this service"}; saved secret values remain masked.</p></div>{canManage ? <button className="button" onClick={() => { setForm(emptyForm); setModalOpen(true); }} type="button">Add variable</button> : null}</div>
    {error ? <div className="state error" role="alert">{error}</div> : null}
    {success ? <div aria-live="polite" className="state success" role="status">{success}</div> : null}
    {ignoredEnvironmentNames.map((key) => <div className="state warning" key={key}>{key} is managed by DeployGuard and was ignored.</div>)}
    {loading ? <p className="muted">Loading environment variables…</p> : null}
    {!loading && setup.managedVariables.length ? <div className="configured-environment-section managed-environment-section"><div><p className="eyebrow">Managed by DeployGuard</p><h3>{setup.managedVariables.length} platform and infrastructure variable{setup.managedVariables.length === 1 ? "" : "s"}</h3><p className="muted">Names and destinations are visible. Values and secret references cannot be edited or revealed.</p></div><EnvVarTable canManage={false} managed variables={setup.managedVariables} /></div> : null}
    {!loading && setup.variables.length ? <div className="configured-environment-section"><div><h3>Saved variables</h3></div><EnvVarTable canManage={canManage} onDelete={remove} onEdit={edit} variables={setup.variables} /></div> : !loading ? <p className="muted">No application variables saved.</p> : null}
    {!loading && canManage ? <details className="environment-import"><summary>Import a .env file</summary><div className="environment-paste-panel"><label className="field"><span>Paste KEY=VALUE lines</span><textarea autoComplete="off" name="environmentVariables" onChange={(event) => parsePaste(event.target.value)} placeholder={'APP_BASE_URL=https://example.test\nFEATURE_FLAG=true\nJWT_SECRET="replace-me"'} rows="7" value={paste} /></label>{pasteResult.errors.map((message) => <p className="inline-action-error" key={message}>{message}</p>)}{pasteResult.warnings.map((message) => <p className="environment-warning" key={message}>{message}</p>)}<div className="paste-preview"><strong>{pasteResult.entries.length} valid variable{pasteResult.entries.length === 1 ? "" : "s"}</strong><span>Blank lines are ignored; duplicate keys are rejected.</span></div><button className="button" disabled={busy || !pasteResult.entries.length || Boolean(pasteResult.errors.length)} onClick={() => saveBulk(pasteResult.entries, pasteResult.ignoredVariableNames || [])} type="button">{busy ? "Saving…" : "Save imported variables"}</button></div></details> : null}
    {modalOpen ? <Modal className="environment-modal" labelledBy="environment-variable-dialog-title" onClose={() => { if (!busy) { setModalOpen(false); setForm(emptyForm); } }}><div className="environment-modal-title"><div><h2 id="environment-variable-dialog-title">{form.id ? "Edit application variable" : "Add an application variable"}</h2><p>Database aliases are accepted unless a managed database owns them.</p></div><button aria-label="Close" className="subtle-button" disabled={busy} onClick={() => { setModalOpen(false); setForm(emptyForm); }} type="button">Close</button></div><EnvVarForm form={form} isSubmitting={busy} onCancel={() => { setModalOpen(false); setForm(emptyForm); }} onChange={(event) => { const { checked, name, type, value } = event.target; setForm((current) => ({ ...current, [name]: type === "checkbox" ? checked : value })); }} onSubmit={async (event) => { await submitSingle(event); setModalOpen(false); }} submitLabel={form.id ? "Save variable" : "Add variable"} /></Modal> : null}
  </section>;
}
