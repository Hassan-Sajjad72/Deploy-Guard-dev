import { useCallback, useEffect, useState } from "react";
import {
  getNotificationSettings,
  refreshNotificationStatus,
  resendNotificationConfirmation,
  subscribeNotifications,
  testNotification,
  updateNotificationSettings,
} from "../../api/platformApi.js";
import { Button, Callout, DataTable, Disclosure, Status, statusTone } from "../common/DesignSystem.jsx";
import Time from "../common/Time.jsx";

const statusLabels = { disabled: "Disabled", not_configured: "Not configured", pending_confirmation: "Pending confirmation", confirmed: "Confirmed", error: "Error" };
const deliveryLabels = { published: "Accepted for delivery", pending: "Pending", retrying: "Retrying", failed_permanent: "Error", skipped_unconfirmed: "Pending confirmation", skipped_unconfigured: "Not configured" };
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
  const statusToneValue = status === "confirmed" ? "success" : status === "error" ? "danger" : status === "pending_confirmation" ? "warning" : "neutral";
  return <section className="notifications">
    <div className="section-head"><div><h2>Email notifications</h2><p>Get project updates at one confirmed email address.</p></div><Status tone={statusToneValue}>{statusLabels[status] || title(status)}</Status></div>
    {error ? <Callout tone="danger">{error}</Callout> : null}{notice ? <Callout tone="success">{notice}</Callout> : null}
    {!settings?.provider?.configured ? <Callout tone="warning" title="Email delivery is unavailable">Email delivery is not configured in this environment.</Callout> : null}
    <div className="panel">
      <div className="panel-row"><label className="check"><input checked={Boolean(settings?.preference?.enabled)} disabled={!canManage || busy} onChange={(event) => void update("enabled", event.target.checked)} type="checkbox" /><span><strong>Send notifications</strong><small>Pause delivery without losing the confirmed email address.</small></span></label></div>
      <div className="panel-row notification-email">
        <label className="field"><span>Email address</span><input autoComplete="email" disabled={!canManage || busy} name="notificationEmail" onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" type="email" value={email} /></label>
        <div className="actions">
          <Button disabled={!canManage || busy || !email.includes("@")} onClick={() => void action(() => subscribeNotifications(projectId, email), (result) => {
            if (result.status === "error") throw new Error(result.lastError || "Amazon SNS could not create the email subscription.");
            if (result.status === "not_configured") throw new Error("Amazon SNS is not configured, so no confirmation email was sent.");
            return result.status === "confirmed" ? `Notification email ${result.destination} is confirmed.` : `Confirmation email sent to ${result.destination}. Confirm it before testing.`;
          })}>{subscription ? "Change email" : "Save email"}</Button>
          {status === "pending_confirmation" || status === "error" ? <Button disabled={!canManage || busy || !settings?.provider?.configured} onClick={() => void action(() => resendNotificationConfirmation(projectId), "A new confirmation request was created.")} tone="ghost">Resend confirmation</Button> : null}
          {status === "pending_confirmation" ? <Button disabled={busy} onClick={() => void action(() => refreshNotificationStatus(projectId), "Subscription status refreshed.")} tone="ghost">Check confirmation</Button> : null}
          {status === "confirmed" ? <Button disabled={!canManage || busy || !settings?.preference?.enabled || !emailMatchesSubscription} onClick={() => void action(() => testNotification(projectId), (result) => result?.status === "published" ? `Test email accepted for delivery to ${subscription.destination} by Amazon SNS.` : "The test email was not accepted for delivery.")} tone="ghost">Send test email</Button> : null}
        </div>
        {status === "confirmed" && !emailMatchesSubscription ? <p className="field-hint">Save and confirm this address before sending a test.</p> : null}
        {subscription ? <p className="field-hint">{subscription.destination} · {statusLabels[status] || title(status)}{subscription.confirmedAt ? <> · confirmed <Time value={subscription.confirmedAt} /></> : null}{subscription.lastError ? ` · ${subscription.lastError}` : ""}</p> : null}
      </div>
      <fieldset className="panel-row notification-preferences" disabled={!canManage || busy || !settings}>
        <legend className="field-label">Send me</legend>
        <label className="check"><input checked={Boolean(settings?.preference?.criticalEnabled)} onChange={(event) => void update("criticalEnabled", event.target.checked)} type="checkbox" /><span>Failures, unhealthy app and cost alerts</span></label>
        <label className="check"><input checked={Boolean(settings?.preference?.successEnabled)} onChange={(event) => void update("successEnabled", event.target.checked)} type="checkbox" /><span>Successful deploys, rollbacks and destroys</span></label>
        <label className="check"><input checked={Boolean(settings?.preference?.stageUpdatesEnabled)} onChange={(event) => void update("stageUpdatesEnabled", event.target.checked)} type="checkbox" /><span>Start and stage updates</span></label>
      </fieldset>
    </div>
    <Disclosure meta={settings?.deliveries?.length ? `${settings.deliveries.length}` : undefined} summary="Delivery history">{settings?.deliveries?.length ? <DataTable caption="Recent project notification delivery history" label="Notification delivery history"><thead><tr><th>Event</th><th>Delivery</th><th>Context</th><th>Time</th></tr></thead><tbody>{settings.deliveries.map((delivery) => <tr key={delivery.id}><td data-label="Event">{title(delivery.eventType)}</td><td data-label="Delivery"><Status tone={delivery.status === "published" ? "success" : statusTone(delivery.status)}>{deliveryLabels[delivery.status] || title(delivery.status)}</Status></td><td data-label="Context">{delivery.metadata?.action ? `${title(delivery.metadata.action)} operation` : "Project event"}</td><td data-label="Time"><Time value={delivery.publishedAt || delivery.createdAt} /></td></tr>)}</tbody></DataTable> : <p className="muted">No notifications have been sent yet.</p>}</Disclosure>
  </section>;
}
