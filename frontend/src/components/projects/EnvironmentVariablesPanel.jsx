import { useEffect, useState } from "react";
import {
  bulkUpsertProjectEnvVars,
  createProjectEnvVar,
  deleteProjectEnvVar,
  getProjectEnvVars,
  updateProjectEnvVar,
} from "../../api/projectApi.js";
import { parseEnvText } from "../../utils/envFileParser.js";
import EnvVarForm from "./EnvVarForm.jsx";
import EnvVarTable from "./EnvVarTable.jsx";

const emptyForm = { id: "", key: "", value: "", isSecret: true, scope: "runtime", isRequired: false, environment: "production", detectedSource: "User supplied" };

export default function EnvironmentVariablesPanel({ projectId, canManage, onSaved }) {
  const [setup, setSetup] = useState({ variables: [], managedVariables: [], reservedVariables: [] });
  const [form, setForm] = useState(emptyForm);
  const [tab, setTab] = useState("paste");
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
      const response = await getProjectEnvVars(projectId);
      setSetup({ variables: response.variables || [], managedVariables: response.managedVariables || [], reservedVariables: response.reservedVariables || [] });
    } catch (caught) {
      setError(caught.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [projectId]);

  async function saveBulk(entries, clientIgnored = []) {
    if (!entries.length) return;
    if (entries.some((item) => !String(item.value || "").length)) {
      setError("Enter a value for every variable before saving.");
      return;
    }
    setBusy(true); setError(""); setSuccess("");
    try {
      const response = await bulkUpsertProjectEnvVars(projectId, entries);
      setIgnoredEnvironmentNames([...new Set([...clientIgnored, ...(response.ignoredVariableNames || [])])].sort());
      setValues({}); setPaste(""); setPasteResult({ entries: [], errors: [], warnings: [] }); setModalOpen(false);
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
      const payload = { key: form.key.trim().toUpperCase(), value: form.value || undefined, isSecret: form.isSecret, scope: form.scope, isRequired: form.isRequired, environment: form.environment, detectedSource: form.detectedSource };
      const response = form.id
        ? await updateProjectEnvVar(projectId, form.id, payload)
        : await createProjectEnvVar(projectId, payload);
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
    try { await deleteProjectEnvVar(projectId, id); await load(); setSuccess("Environment variable deleted."); }
    catch (caught) { setError(caught.message); }
    finally { setBusy(false); }
  }

  function edit(variable) {
    setTab("single");
    setForm({ ...emptyForm, ...variable, value: "" });
  }

  return <section className="environment-manager panel-flat">
    <div className="environment-manager-header"><div><p className="eyebrow">Environment</p><h2>Additional variables</h2><p>Add optional application settings. Managed service aliases are protected, and saved secrets are never returned by the API.</p></div>{canManage ? <button className="button" onClick={() => setModalOpen(true)} type="button">Add variable</button> : null}</div>
    {error ? <div className="state error" role="alert">{error}</div> : null}
    {success ? <div className="state success">{success}</div> : null}
    {ignoredEnvironmentNames.map((key) => <div className="state warning" key={key}>{key} is managed by DeployGuard and was ignored.</div>)}
    <div className="environment-tabs" role="tablist">
      <button className={tab === "paste" ? "active" : ""} onClick={() => setTab("paste")} type="button">Paste .env</button>
      <button className={tab === "single" ? "active" : ""} onClick={() => setTab("single")} type="button">Single variable</button>
    </div>
    {loading ? <p className="muted">Loading environment variables…</p> : null}
    {!loading && tab === "paste" ? <div className="environment-paste-panel"><label className="field"><span>Paste KEY=VALUE lines</span><textarea onChange={(event) => parsePaste(event.target.value)} placeholder={'DB_HOST=example\nDB_NAME=mydb\nJWT_SECRET="replace-me"'} rows="9" value={paste} /></label>{pasteResult.errors.map((message) => <p className="inline-action-error" key={message}>{message}</p>)}{pasteResult.warnings.map((message) => <p className="environment-warning" key={message}>{message}</p>)}<div className="paste-preview"><strong>{pasteResult.entries.length} valid variable{pasteResult.entries.length === 1 ? "" : "s"}</strong><span>Comments and blank lines are ignored. Duplicate keys are rejected.</span></div>{canManage ? <button className="button" disabled={busy || !pasteResult.entries.length || Boolean(pasteResult.errors.length)} onClick={() => saveBulk(pasteResult.entries, pasteResult.ignoredVariableNames || [])} type="button">{busy ? "Saving…" : "Save pasted variables"}</button> : null}</div> : null}
    {!loading && tab === "single" && canManage ? <EnvVarForm form={form} isSubmitting={busy} onCancel={form.id ? () => setForm(emptyForm) : null} onChange={(event) => { const { checked, name, type, value } = event.target; setForm((current) => ({ ...current, [name]: type === "checkbox" ? checked : value })); }} onSubmit={submitSingle} submitLabel={form.id ? "Update variable" : "Add variable"} /> : null}
    {!loading && setup.managedVariables.length ? <div className="configured-environment-section managed-environment-section"><div><p className="eyebrow">Managed by DeployGuard</p><h3>{setup.managedVariables.length} platform and infrastructure variable{setup.managedVariables.length === 1 ? "" : "s"}</h3><p className="muted">Names and destinations are visible. Values and secret references cannot be edited or revealed.</p></div><EnvVarTable canManage={false} managed variables={setup.managedVariables} /></div> : null}
    {!loading && setup.variables.length ? <div className="configured-environment-section"><div><p className="eyebrow">Application variables</p><h3>{setup.variables.length} saved variable{setup.variables.length === 1 ? "" : "s"}</h3></div><EnvVarTable canManage={canManage} onDelete={remove} onEdit={edit} variables={setup.variables} /></div> : null}
    {modalOpen ? <div className="environment-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && setModalOpen(false)}><section aria-modal="true" className="environment-modal" role="dialog"><div className="environment-modal-title"><div><p className="eyebrow">Environment</p><h2>Add an application variable</h2><p>Managed service aliases are rejected explicitly. Secret values remain masked after save.</p></div><button aria-label="Close" className="subtle-button" disabled={busy} onClick={() => setModalOpen(false)} type="button">Close</button></div><EnvVarForm form={form} isSubmitting={busy} onChange={(event) => { const { checked, name, type, value } = event.target; setForm((current) => ({ ...current, [name]: type === "checkbox" ? checked : value })); }} onSubmit={async (event) => { await submitSingle(event); setModalOpen(false); }} submitLabel="Add variable" /></section></div> : null}
  </section>;
}
