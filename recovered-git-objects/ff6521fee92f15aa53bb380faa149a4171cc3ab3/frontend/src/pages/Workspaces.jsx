import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Callout, PageHeader } from "../components/common/DesignSystem.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { useAuth } from "../hooks/useAuth.js";
import { archiveAgencyRecord, createAgencyClient, createAgencyEngagement, createAwsBinding, createWorkspace, getAgencyPortfolio, getAwsBindings, getBindingTrustPolicy, getWorkspaceMembers, getWorkspaces, removeWorkspaceMember, renameAgencyRecord, revokeAwsBinding, setWorkspaceMember, verifyAwsBinding } from "../api/workspaceApi.js";

export default function Workspaces() {
  const { user } = useAuth();
  const [workspaces, setWorkspaces] = useState([]);
  const [selected, setSelected] = useState("");
  const [members, setMembers] = useState([]);
  const [bindings, setBindings] = useState([]);
  const [portfolio, setPortfolio] = useState({ clients: [], engagements: [] });
  const [trustPolicy, setTrustPolicy] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const request = useRef(0);
  const workspace = workspaces.find((item) => item.id === selected);
  const canManage = user?.role !== "readonly" && ["owner", "admin"].includes(workspace?.role);

  useEffect(() => {
    let active = true;
    getWorkspaces().then(({ workspaces: items }) => { if (active) { setWorkspaces(items); setSelected(items[0]?.id || ""); } })
      .catch((caught) => { if (active) setError(caught.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!selected) return;
    const current = ++request.current;
    setMembers([]); setBindings([]); setPortfolio({ clients: [], engagements: [] }); setTrustPolicy(null); setError(""); setLoading(true);
    Promise.all([getWorkspaceMembers(selected), getAwsBindings(selected), workspace?.kind === "agency" ? getAgencyPortfolio(selected) : null])
      .then(([people, accounts, agency]) => { if (current === request.current) { setMembers(people.members); setBindings(accounts.bindings); if (agency) setPortfolio(agency); } })
      .catch((caught) => { if (current === request.current) setError(caught.message); })
      .finally(() => { if (current === request.current) setLoading(false); });
    return () => { request.current++; };
  }, [selected]);

  async function run(action, message) {
    setBusy(true); setError(""); setNotice("");
    try {
      await action();
      const [people, accounts, agency] = await Promise.all([getWorkspaceMembers(selected), getAwsBindings(selected), workspace?.kind === "agency" ? getAgencyPortfolio(selected) : null]);
      setMembers(people.members); setBindings(accounts.bindings); if (agency) setPortfolio(agency); setNotice(message);
    } catch (caught) { setError(caught.message); } finally { setBusy(false); }
  }

  async function addWorkspace(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true); setError("");
    try {
      const { workspace: created } = await createWorkspace({ name: values.get("name"), kind: values.get("kind") });
      const result = await getWorkspaces(); setWorkspaces(result.workspaces); setSelected(created.id); form.reset();
    } catch (caught) { setError(caught.message); } finally { setBusy(false); }
  }

  function addBinding(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    void run(async () => {
      const result = await createAwsBinding(selected, { accountId: values.get("accountId"), roleArn: values.get("roleArn"), regions: String(values.get("regions")).split(",").map((region) => region.trim()).filter(Boolean) });
      setTrustPolicy(result.trustPolicy); form.reset();
    }, "AWS account binding created. Configure the role trust policy in your AWS account, then verify it.");
  }

  function addMember(event) {
    event.preventDefault();
    const form = event.currentTarget; const values = new FormData(form);
    void run(async () => { await setWorkspaceMember(selected, { userId: Number(values.get("userId")), role: values.get("role") }); form.reset(); }, "Workspace membership saved.");
  }

  return <div className="page settings-page">
    <PageHeader title="Workspaces & AWS accounts" description="Manage your personal or team workspace and authorize customer AWS accounts." />
    {error ? <Callout title="Unable to complete this action" tone="danger"><p role="alert">{error}</p></Callout> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <div className="field"><label htmlFor="workspace-selection">Workspace</label><select id="workspace-selection" disabled={busy} value={selected} onChange={(event) => setSelected(event.target.value)}>{workspaces.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.kind} · {item.role}</option>)}</select></div>
    {user?.role !== "readonly" ? <details className="disclosure"><summary>Create a team or agency workspace</summary><form onSubmit={addWorkspace} className="form-grid">
      <label className="field"><span>Name</span><input name="name" required maxLength={120} disabled={busy} /></label>
      <label className="field"><span>Workspace type</span><select name="kind" disabled={busy}><option value="team">Team</option><option value="agency">Agency</option></select></label>
      <Button type="submit" disabled={busy}>Create workspace</Button>
    </form></details> : null}
    {loading ? <LoadingState message="Loading workspace…" /> : workspace ? <>
      <section className="panel"><h2>Members</h2><ul>{members.map((member) => <li key={member.userId}>{member.githubLogin || member.name} · {member.role} · User ID {member.userId} {canManage && member.role !== "owner" ? <Button disabled={busy} onClick={() => void run(() => removeWorkspaceMember(selected, member.userId), "Workspace membership removed.")}>Remove member</Button> : null}</li>)}</ul>
        {canManage && workspace.kind !== "personal" ? <form onSubmit={addMember} className="form-grid">
          <label className="field"><span>Existing DeployGuard user ID</span><input name="userId" type="number" min={1} required disabled={busy} /></label>
          <label className="field"><span>Role</span><select name="role" disabled={busy}><option value="engineer">Engineer</option><option value="approver">Deployment approver</option><option value="viewer">Viewer</option><option value="admin">Workspace admin</option></select></label>
          <Button type="submit" disabled={busy}>Save member</Button>
        </form> : null}
      </section>
      <section className="panel"><h2>AWS account bindings</h2><p>Account verification checks authorization for read operations. Customer deployment authority requires separate execution and hosting verification.</p>
        {bindings.length ? <ul>{bindings.map((binding) => <li key={binding.id}><strong>{binding.accountId}</strong> · {binding.regions.join(", ")} · {binding.verificationStatus}<p className="mono" style={{ overflowWrap: "anywhere" }}>{binding.roleArn}</p>
          {canManage ? <div className="actions"><Button disabled={busy} onClick={() => void run(async () => setTrustPolicy((await getBindingTrustPolicy(selected, binding.id)).trustPolicy), "Trust policy loaded.")}>View trust policy</Button>
            <Button disabled={busy || binding.verificationStatus === "revoked"} onClick={() => void run(() => verifyAwsBinding(selected, binding.id), "AWS account identity and read authorization verified.")}>Verify account</Button>
            <Button disabled={busy || binding.verificationStatus === "revoked"} onClick={() => void run(() => revokeAwsBinding(selected, binding.id), "AWS binding revoked in DeployGuard.")}>Revoke binding</Button></div> : null}
        </li>)}</ul> : <p>No AWS account bindings yet.</p>}
        {canManage ? <form onSubmit={addBinding} className="form-grid">
          <label className="field"><span>AWS account ID</span><input name="accountId" required pattern="[0-9]{12}" maxLength={12} disabled={busy} /></label>
          <label className="field"><span>Customer IAM role ARN</span><input name="roleArn" required maxLength={600} placeholder="arn:aws:iam::123456789012:role/DeployGuard" disabled={busy} /></label>
          <label className="field"><span>Authorized AWS regions, separated by commas</span><input name="regions" required placeholder="us-east-1" disabled={busy} /></label>
          <Button type="submit" disabled={busy}>Add AWS account</Button>
        </form> : null}
        {trustPolicy ? <details className="disclosure" open><summary>Customer role trust policy</summary><p>Review and configure this policy on the customer IAM role in AWS. DeployGuard does not apply it automatically.</p><pre style={{ overflowX: "auto" }}>{JSON.stringify(trustPolicy, null, 2)}</pre></details> : null}
      </section>
      {workspace.kind === "agency" ? <AgencyPortfolio portfolio={portfolio} bindings={bindings} canManage={canManage} busy={busy} run={run} workspaceId={selected} /> : null}
      <Link className="btn" to="/deploy">Create a project</Link>
    </> : null}
  </div>;
}

function AgencyPortfolio({ portfolio, bindings, canManage, busy, run, workspaceId }) {
  return <section className="panel"><h2>Client portfolio</h2><p>Engagements record the AWS account authorized by each client. Archiving preserves project history and AWS workloads.</p>
    {portfolio.clients.map((client) => <article key={client.id}><h3>{client.name}{client.archivedAt ? " · Archived" : ""}</h3><Link to={`/projects?clientId=${encodeURIComponent(client.id)}`}>View client projects</Link>
      {canManage && !client.archivedAt ? <AgencyRecordActions busy={busy} kind="clients" record={client} run={run} workspaceId={workspaceId} /> : null}
      <ul>{portfolio.engagements.filter((item) => item.clientId === client.id).map((engagement) => <li key={engagement.id}><strong>{engagement.name}</strong> · {engagement.archivedAt ? "Archived" : "Active"}<p>Authorized AWS account: {bindings.find((item) => item.id === engagement.awsAccountBindingId)?.accountId || "Unavailable"}</p><p>Authorization reference: {engagement.authorizationReference}</p><Link to={`/projects?engagementId=${encodeURIComponent(engagement.id)}`}>View engagement projects</Link>
        {canManage && !client.archivedAt && !engagement.archivedAt ? <AgencyRecordActions busy={busy} kind="engagements" record={engagement} run={run} workspaceId={workspaceId} /> : null}
      </li>)}</ul>
      {canManage && !client.archivedAt ? <details className="disclosure"><summary>Add engagement for {client.name}</summary><form className="form-grid" onSubmit={(event) => {
        event.preventDefault(); const form = event.currentTarget; const values = new FormData(form);
        void run(async () => { await createAgencyEngagement(workspaceId, client.id, { name: values.get("name"), awsAccountBindingId: values.get("bindingId"), authorizationReference: values.get("authorizationReference"), clientAuthorizationConfirmed: values.get("authorizationConfirmed") === "on" }); form.reset(); }, "Client-authorized engagement created.");
      }}><label className="field"><span>Engagement name</span><input name="name" required maxLength={120} disabled={busy} /></label>
        <label className="field" htmlFor={`client-account-${client.id}`}><span>Client AWS account</span><select aria-label="Client AWS account" id={`client-account-${client.id}`} name="bindingId" required disabled={busy}><option value="">Select an account</option>{bindings.filter((item) => item.verificationStatus !== "revoked").map((item) => <option key={item.id} value={item.id}>{item.accountId} · {item.roleArn}</option>)}</select></label>
        <label className="field"><span>Client authorization reference</span><input name="authorizationReference" required maxLength={1000} disabled={busy} placeholder="Signed authorization or contract reference" /></label>
        <label><input name="authorizationConfirmed" type="checkbox" required disabled={busy} /> I confirm the client authorized this AWS account for this engagement.</label>
        <Button type="submit" disabled={busy}>Create engagement</Button></form></details> : null}
    </article>)}
    {canManage ? <form className="form-grid" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const values = new FormData(form); void run(async () => { await createAgencyClient(workspaceId, { name: values.get("name") }); form.reset(); }, "Client created."); }}><label className="field"><span>New client name</span><input name="name" required maxLength={120} disabled={busy} /></label><Button type="submit" disabled={busy}>Create client</Button></form> : null}
  </section>;
}

function AgencyRecordActions({ busy, kind, record, run, workspaceId }) {
  return <details className="disclosure"><summary>Manage {record.name}</summary>
    <form className="form-grid" onSubmit={(event) => { event.preventDefault(); const name = new FormData(event.currentTarget).get("name"); void run(() => renameAgencyRecord(workspaceId, kind, record.id, name), "Name updated."); }}><label className="field"><span>{kind === "clients" ? "Client" : "Engagement"} name</span><input name="name" defaultValue={record.name} required maxLength={120} disabled={busy} /></label><Button type="submit" disabled={busy}>Rename</Button></form>
    <form className="form-grid" onSubmit={(event) => { event.preventDefault(); const reason = new FormData(event.currentTarget).get("reason"); void run(() => archiveAgencyRecord(workspaceId, kind, record.id, reason), "Archived. Workloads and evidence are retained."); }}><label className="field"><span>Archive reason</span><input name="reason" required maxLength={1000} disabled={busy} /></label><Button type="submit" disabled={busy}>Archive {kind === "clients" ? "client" : "engagement"}</Button></form>
  </details>;
}
