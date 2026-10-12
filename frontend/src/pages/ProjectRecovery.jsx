import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Button, Callout, PageHeader } from "../components/common/DesignSystem.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { checkRepair, decideRecovery, executeRecovery, proposeRepair, publishRepair, recoveryRegistry, recoveryRequests, repairProposals, requestRecovery, verifyRecovery } from "../api/recoveryApi.js";

export default function ProjectRecovery() {
  const { projectId } = useParams(); const generation = useRef(0);
  const [books, setBooks] = useState([]); const [history, setHistory] = useState({ requests: [], canRequest: false, canApprove: false });
  const [repairs, setRepairs] = useState([]); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function refresh(current) { const [requests, proposals] = await Promise.all([recoveryRequests(projectId), repairProposals(projectId)]); if (current === generation.current) { setHistory(requests); setRepairs(proposals.proposals); } }
  useEffect(() => {
    const current = ++generation.current; setLoading(true); setBusy(false); setError(""); setBooks([]); setRepairs([]); setHistory({ requests: [], canRequest: false, canApprove: false });
    Promise.all([recoveryRegistry(projectId), recoveryRequests(projectId), repairProposals(projectId)]).then(([registry, requests, proposals]) => { if (current === generation.current) { setBooks(registry.runbooks); setHistory(requests); setRepairs(proposals.proposals); } }).catch((caught) => { if (current === generation.current) setError(caught.message); }).finally(() => { if (current === generation.current) setLoading(false); });
    return () => { generation.current++; };
  }, [projectId]);
  async function action(work) { const current = generation.current; setBusy(true); setError(""); try { await work(); await refresh(current); } catch (caught) { if (current === generation.current) setError(caught.message); } finally { if (current === generation.current) setBusy(false); } }
  function submit(event) { event.preventDefault(); const form = new FormData(event.currentTarget); const optional = Object.fromEntries(["serviceId", "targetOperationId"].filter((name) => form.get(name)).map((name) => [name, form.get(name)])); if (form.get("replicas")) optional.replicas = Number(form.get("replicas")); return action(() => requestRecovery(projectId, { incidentId: form.get("incidentId"), runbookId: form.get("runbookId"), monthlyBudgetUsd: Number(form.get("budget")), ...optional })); }
  function repair(event) { event.preventDefault(); const form = new FormData(event.currentTarget); return action(() => proposeRepair(projectId, { incidentId: form.get("incidentId"), sourceSha: form.get("sourceSha"), defectEvidence: form.get("defectEvidence"), files: JSON.parse(form.get("files")) })); }
  if (loading) return <LoadingState message="Loading governed recovery…" />;
  return <div className="page-stack" style={{ overflowWrap: "anywhere" }}><PageHeader title="Governed recovery" description="Prepare bounded recovery for a verified incident, review the exact scope, then independently verify the outcome." />
    <Button disabled={busy} onClick={() => action(() => Promise.resolve())}>Refresh evidence</Button>
    {error && <Callout tone="error" title="Action could not complete">{error}</Callout>}
    <Callout title="Verified evidence and approval required">Recovery requires a current verified incident, immutable source, precise resource ownership and complete cost evidence. Customer actions remain blocked until account mutation authority is verified. <Link to={`/projects/${projectId}/intelligence`}>Investigate an incident</Link>.</Callout>
    <section className="surface-card"><h2>Approved runbooks</h2>{books.map((book) => <details key={book.id}><summary>{book.title} · version {book.version}</summary><p>Maximum {book.maxAttempts} attempts. Verification deadline: {book.timeoutSeconds} seconds.</p><ul>{book.preconditions.map((item) => <li key={item}>{item}</li>)}</ul></details>)}</section>
    {history.canRequest && <form className="surface-card page-stack" onSubmit={submit}><h2>Request recovery</h2>
      <label>Verified incident ID<input name="incidentId" required /></label><label htmlFor="recovery-runbook">Runbook</label><select id="recovery-runbook" name="runbookId">{books.map((book) => <option key={book.id} value={book.id}>{book.title}</option>)}</select>
      <label>Maximum monthly AWS cost (USD)<input type="number" min="0" max="1000000" step="0.01" name="budget" required /></label>
      <label>Exact rollback or failed operation ID<input name="targetOperationId" /></label><label>ECS service ID<input name="serviceId" /></label>
      <label>Requested replica count (replica adjustment only)<input name="replicas" type="number" min="1" max="4" /></label>
      <Button type="submit" disabled={busy}>Prepare recovery request</Button>
    </form>}
    <section className="surface-card page-stack"><h2>Recovery requests</h2>{!history.requests.length && <p>No recovery requests.</p>}{history.requests.map((request) => <article className="surface-card page-stack" key={request.id}>
      <h3>{books.find((book) => book.id === request.content.runbookId)?.title || request.content.runbookId}</h3><p>Status: <strong>{request.status.toUpperCase()}</strong></p><p>Source: {request.content.scope.sourceSha}. Region: {request.content.scope.region}. Monthly ceiling: ${request.content.cost.conservativeMonthlyCeilingUsd}.</p>
      <details><summary>Review exact approved scope</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(request.content, null, 2)}</pre><p style={{ overflowWrap: "anywhere" }}>Fingerprint: {request.fingerprint}</p></details>
      {request.outcome && <p>Verification: {request.outcome.verification || "UNVERIFIED"}. {request.outcome.reason}</p>}
      {history.canApprove && request.status === "requested" && <form onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); action(() => decideRecovery(projectId, request.id, { fingerprint: request.fingerprint, decision: data.get("decision"), reason: data.get("reason") })); }}><label>Review reason<input name="reason" required maxLength="1000" /></label><label htmlFor={`recovery-decision-${request.id}`}>Decision</label><select id={`recovery-decision-${request.id}`} name="decision"><option value="rejected">Reject</option><option value="approved">Approve exact scope and budget</option></select><Button disabled={busy} type="submit">Record human decision</Button></form>}
      {history.canRequest && request.status === "approved" && <Button disabled={busy} onClick={() => action(() => executeRecovery(projectId, request.id, request.fingerprint))}>Execute approved recovery</Button>}
      {request.status === "running" && <Button disabled={busy} onClick={() => action(() => verifyRecovery(projectId, request.id))}>Check independent recovery outcome</Button>}
    </article>)}</section>
    {history.canRequest && <form className="surface-card page-stack" onSubmit={repair}><h2>Supervised code repair proposal</h2><p>Propose up to ten existing application files (128 KiB total). Checks run only in a configured isolated sandbox without production credentials. A passing proposal still requires human approval to open a draft pull request and an approved deployment.</p>
      <label>Verified incident ID<input name="incidentId" required /></label><label>Exact source SHA<input name="sourceSha" required pattern="[a-fA-F0-9]{40}" /></label><label>Reproducible defect evidence<textarea name="defectEvidence" required maxLength="2000" /></label><label>Proposed file replacements (JSON array)<textarea name="files" required placeholder={'[{"path":"src/app.js","content":"reviewable replacement"}]'} /></label><Button type="submit" disabled={busy}>Save reviewable repair proposal</Button>
    </form>}
    <section className="surface-card page-stack"><h2>Repair proposals</h2>{!repairs.length && <p>No repair proposals.</p>}{repairs.map((proposal) => <article className="surface-card page-stack" key={proposal.id}><h3>Repair {proposal.id.slice(0, 8)}</h3><p>Checks: {proposal.status.toUpperCase()}. Operational recovery: UNVERIFIED.</p><p>{proposal.content.defectEvidence}</p><details><summary>Review proposed changes</summary>{proposal.content.files.map((file) => <div key={file.path}><strong>{file.path}</strong><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{file.content}</pre></div>)}</details>
      {proposal.checks && <p>Defect reproduction: {proposal.checks.defectReproduction}. Application tests: {proposal.checks.applicationTests}. API contracts: {proposal.checks.apiContractTests}. {proposal.checks.reason}</p>}
      {history.canRequest && !proposal.pullRequestUrl && <Button disabled={busy || proposal.status === "checking"} onClick={() => action(() => checkRepair(projectId, proposal.id, proposal.fingerprint))}>Run isolated checks</Button>}
      {history.canApprove && proposal.status === "passed" && <Button disabled={busy} onClick={() => action(() => publishRepair(projectId, proposal.id, proposal.fingerprint))}>Approve publication of draft pull request</Button>}
      {proposal.pullRequestUrl && <a href={proposal.pullRequestUrl} rel="noopener noreferrer" target="_blank">Review draft pull request</a>}
    </article>)}</section>
  </div>;
}
