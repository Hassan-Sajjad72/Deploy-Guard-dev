import { useEffect, useState } from "react";

export default function CostSettingsForm({ canManage, isSaving, onSave, settings }) {
  const [form, setForm] = useState({
    subscriptionTier: "free",
    warningThresholdMonthlyCost: 25,
    currency: "USD",
  });

  useEffect(() => {
    if (settings) {
      setForm({
        subscriptionTier: settings.subscriptionTier || "free",
        warningThresholdMonthlyCost: settings.warningThresholdMonthlyCost || 25,
        currency: settings.currency || "USD",
      });
    }
  }, [settings]);

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    await onSave({
      ...form,
      warningThresholdMonthlyCost: Number(form.warningThresholdMonthlyCost),
    });
  }

  return (
    <section className="panel">
      <h2>Cost Settings</h2>
      <form className="filters" onSubmit={submit}>
        <label className="field">
          <span>Tier</span>
          <select
            disabled={!canManage}
            onChange={(event) => updateField("subscriptionTier", event.target.value)}
            value={form.subscriptionTier}
          >
            <option value="free">Free</option>
            <option value="starter">Starter</option>
            <option value="pro">Pro</option>
            <option value="enterprise">Enterprise</option>
          </select>
        </label>
        <label className="field">
          <span>Warning Threshold</span>
          <input
            disabled={!canManage}
            min="0"
            onChange={(event) =>
              updateField("warningThresholdMonthlyCost", event.target.value)
            }
            type="number"
            value={form.warningThresholdMonthlyCost}
          />
        </label>
        <label className="field">
          <span>Currency</span>
          <input
            disabled={!canManage}
            onChange={(event) => updateField("currency", event.target.value)}
            value={form.currency}
          />
        </label>
        {canManage ? (
          <button className="button" disabled={isSaving} type="submit">
            {isSaving ? "Saving..." : "Save Settings"}
          </button>
        ) : null}
      </form>
    </section>
  );
}
