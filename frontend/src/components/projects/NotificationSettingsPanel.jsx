import { useCallback, useEffect, useState } from "react";
import {
  getNotificationSettings,
  refreshNotificationStatus,
  resendNotificationConfirmation,
  subscribeNotifications,
  testNotification,
  updateNotificationSettings,
} from "../../api/platformApi.js";
import { Card, DataTable, StatusChip } from "../common/DesignSystem.jsx";

const statusLabels = { disabled: "Disabled", not_configured: "Not configured", pending_confirmation: "Pending confirmation", confirmed: "Confirmed", error: "Error" };
const deliveryLabels = { published: "Published to SNS", pending: "Pending", retrying: "Retrying", failed_permanent: "Error", skipped_unconfirmed: "Pending confirmation", skipped_unconfigured: "Not configured" };
function timestamp(value) { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—"; }
function title(value) { return String(value || "notification").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }

export default function NotificationSettingsPanel({ projectId, canManage }) {
  const [settings, setSettings] = useState(null);
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const value = await getNotificationSettings(projectId);
      setSettings(value);
      setEmail((current) => current || value.subscription?.destination || "");
      setError("");
    } catch (caught) { setError(caught.message); }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  async function action(work, success) {
    setBusy(true); setError(""); setNotice("");
    try { const result = await work(); await load(); setNotice(typeof success === "function" ? success(result) : success); } catch (caught) { setError(caught.message); }
    finally { setBusy(false); }
  }
  async function update(key, value) {
    const preference = settings.preference;
    await action(() => updateNotificationSettings(projectId, { enabled: preference.enabled, criticalEnabled: preference.criticalEnabled, successEnabled: preference.successEnabled, stageUpdatesEnabled: preference.stageUpdatesEnabled, [key]: value }), "Notification preferences saved.");
  }
  const status = settings?.configurationStatus || "not_configured";
  const subscription = settings?.subscription;
  const emailMatchesSubscription = email.trim().toLowerCase() === String(subscription?.destination || "").trim().toLowerCase();
  return <Card className="notification-overview-card">
    <div className="compact-section-heading">
      <div><p className="eyebrow">Project notifications</p><h2>Email lifecycle notifications</h2><p>Amazon SNS notifications are scoped to this project and emitted from authoritative backend lifecycle transitions.</p></div>
      <StatusChip status={status === "confirmed" ? "healthy" : status === "error" ? "failed" : status}>{statusLabels[status] || title(status)}</StatusChip>
    </div>
    {error ? <p className="state error">{error}</p> : null}{notice ? <p aria-live="polite" className="state success" role="status">{notice}</p> : null}
    {!settings?.provider?.configured ? <p className="state warning">Amazon SNS delivery is disabled in the current environment. Preferences can be saved, but confirmation email cannot be sent until NOTIFICATION_DELIVERY_ENABLED=true and AWS credentials are available.</p> : null}
    <div className="notification-config-grid">
      <div className="notification-config-fields">
        <label className="settings-toggle"><input checked={Boolean(settings?.preference?.enabled)} disabled={!canManage || busy} onChange={(event) => void update("enabled", event.target.checked)} type="checkbox" /><span><strong>Enable notifications</strong><small>Pause delivery without losing the confirmed email configuration.</small></span></label>
        <label className="field"><span>Notification email</span><input autoComplete="email" disabled={!canManage || busy} name="notificationEmail" onChange={(event) => setEmail(event.target.value)} placeholder="operator@example.com" type="email" value={email} /></label>
        <div className="quick-actions">
          <button className="secondary-button" disabled={!canManage || busy || !email.includes("@")} onClick={() => void action(() => subscribeNotifications(projectId, email), (result) => {
            if (result.status === "error") throw new Error(result.lastError || "Amazon SNS could not create the email subscription.");
            if (result.status === "not_configured") throw new Error("Amazon SNS is not configured, so no confirmation email was sent.");
            return result.status === "confirmed" ? `Notification email ${result.destination} is confirmed.` : `Confirmation email sent to ${result.destination}. Confirm it before testing.`;
          })} type="button">{subscription ? "Configure/change email" : "Configure email"}</button>
          {status === "pending_confirmation" || status === "error" ? <button className="subtle-button" disabled={!canManage || busy || !settings?.provider?.configured} onClick={() => void action(() => resendNotificationConfirmation(projectId), "A new confirmation request was created.")} type="button">Resend confirmation</button> : null}
          {status === "pending_confirmation" ? <button className="subtle-button" disabled={busy} onClick={() => void action(() => refreshNotificationStatus(projectId), "Subscription status refreshed.")} type="button">Check confirmation</button> : null}
          {status === "confirmed" ? <button className="subtle-button" disabled={!canManage || busy || !settings?.preference?.enabled || !emailMatchesSubscription} onClick={() => void action(() => testNotification(projectId), (result) => result?.status === "published" ? `Test notification published to SNS for ${subscription.destination}.` : "Test notification was not published.")} type="button">Send test email</button> : null}
        </div>
        {status === "confirmed" && !emailMatchesSubscription ? <p className="state warning">Save and confirm this email address before sending a test notification.</p> : null}
        {subscription ? <p className="muted">{subscription.destination} · {statusLabels[status] || title(status)}{subscription.confirmedAt ? ` · Confirmed ${timestamp(subscription.confirmedAt)}` : ""}{subscription.lastError ? ` · ${subscription.lastError}` : ""}</p> : null}
      </div>
      <fieldset className="notification-preferences" disabled={!canManage || busy || !settings}>
        <legend>Notification preferences</legend>
        <label><input checked={Boolean(settings?.preference?.criticalEnabled)} onChange={(event) => void update("criticalEnabled", event.target.checked)} type="checkbox" /> Failures, unhealthy runtime and cost threshold</label>
        <label><input checked={Boolean(settings?.preference?.successEnabled)} onChange={(event) => void update("successEnabled", event.target.checked)} type="checkbox" /> Deploy, redeploy, rollback and destroy success</label>
        <label><input checked={Boolean(settings?.preference?.stageUpdatesEnabled)} onChange={(event) => void update("stageUpdatesEnabled", event.target.checked)} type="checkbox" /> Optional start and stage updates</label>
      </fieldset>
    </div>
    <div className="notification-history"><h3>Recent delivery history</h3>{settings?.deliveries?.length ? <DataTable caption="Recent project notification delivery history" className="responsive-record-table" label="Notification delivery history"><thead><tr><th>Event</th><th>Delivery</th><th>Context</th><th>Time</th></tr></thead><tbody>{settings.deliveries.map((delivery) => <tr key={delivery.id}><td data-label="Event">{title(delivery.eventType)}</td><td data-label="Delivery"><StatusChip status={delivery.status === "published" ? "healthy" : delivery.status.includes("failed") ? "failed" : delivery.status}>{deliveryLabels[delivery.status] || title(delivery.status)}</StatusChip></td><td data-label="Context">{delivery.metadata?.action ? `${title(delivery.metadata.action)} operation` : "Project event"}</td><td data-label="Time">{timestamp(delivery.publishedAt || delivery.createdAt)}</td></tr>)}</tbody></DataTable> : <p className="muted">No lifecycle notification deliveries have been recorded for this project.</p>}</div>
  </Card>;
}
